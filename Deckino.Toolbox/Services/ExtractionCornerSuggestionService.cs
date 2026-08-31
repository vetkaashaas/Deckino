using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Deckino.Toolbox.Services;

public sealed record ExtractionCornerSuggestion(
    string ModelVersion,
    string CheckpointSha256,
    IReadOnlyList<NormalizedPoint>? Corners,
    bool GeometryValid,
    bool WouldBeAccepted,
    string? RejectionReason,
    double PresenceProbability,
    double AmbiguityMargin,
    TimeSpan Elapsed);

public interface IExtractionCornerSuggestionService
{
    Task<ExtractionCornerSuggestion> SuggestAsync(string imagePath, CancellationToken cancellationToken);
    Task StopAsync();
}

public sealed class ExtractionCornerSuggestionService(
    TrainingPaths paths,
    PythonProcessRunner runner,
    ExtractionProductionWorkflowService workflow,
    ApplicationLogService applicationLog) : IExtractionCornerSuggestionService, IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Process? _worker;
    private string? _workerModelVersion;
    private string? _workerCheckpointHash;
    private Task? _stderrPump;
    private CancellationTokenSource? _activeRequestCancellation;

    public async Task<ExtractionCornerSuggestion> SuggestAsync(
        string imagePath,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Interlocked.Exchange(ref _activeRequestCancellation, requestCancellation);
        try
        {
            var requestToken = requestCancellation.Token;
            var model = workflow.ResolveSuggestionModel();
            if (_worker is null || _worker.HasExited
                || _workerModelVersion != model.ModelVersion)
            {
                var checkpointHash = await HashFileAsync(model.CheckpointPath, requestToken);
                await StartWorkerAsync(model, checkpointHash, requestToken);
            }

            var requestId = Guid.NewGuid().ToString("N");
            var request = JsonSerializer.Serialize(new
            {
                request_id = requestId,
                image_path = Path.GetFullPath(imagePath),
            });
            var stopwatch = Stopwatch.StartNew();
            await _worker!.StandardInput.WriteLineAsync(request);
            await _worker.StandardInput.FlushAsync();

            while (true)
            {
                var line = await _worker.StandardOutput.ReadLineAsync()
                    .WaitAsync(TimeSpan.FromSeconds(30), requestToken);
                if (line is null) throw new InvalidOperationException("The extraction suggestion worker stopped unexpectedly.");
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (!root.TryGetProperty("request_id", out var id) || id.GetString() != requestId) continue;
                var eventName = root.GetProperty("event").GetString();
                if (eventName == "extraction_suggestion_error")
                    throw new InvalidOperationException(root.GetProperty("message").GetString()
                        ?? "The extraction model could not suggest corners.");
                if (eventName != "extraction_suggestion") continue;
                stopwatch.Stop();
                requestToken.ThrowIfCancellationRequested();
                var corners = ParseCorners(root);
                var result = new ExtractionCornerSuggestion(
                    root.GetProperty("model_version").GetString()!,
                    root.GetProperty("checkpoint_sha256").GetString()!,
                    corners,
                    root.GetProperty("geometry_valid").GetBoolean(),
                    root.GetProperty("would_be_accepted").GetBoolean(),
                    root.TryGetProperty("rejection_reason", out var rejection) && rejection.ValueKind == JsonValueKind.String
                        ? rejection.GetString() : null,
                    root.GetProperty("presence_probability").GetDouble(),
                    root.GetProperty("ambiguity_margin").GetDouble(),
                    stopwatch.Elapsed);
                applicationLog.Information("corner-suggestion",
                    $"{result.ModelVersion} suggested {result.Corners?.Count ?? 0} corners for {Path.GetFileName(imagePath)} "
                    + $"in {result.Elapsed.TotalMilliseconds:N0} ms; presence={result.PresenceProbability:P1}; "
                    + $"accepted={result.WouldBeAccepted}; reason={result.RejectionReason ?? "none"}.");
                return result;
            }
        }
        catch
        {
            // A timeout or cancelled caller may leave an unread response in stdout.
            // Restarting guarantees that the next request cannot consume a stale reply.
            StopWorkerCore();
            throw;
        }
        finally
        {
            Interlocked.CompareExchange(ref _activeRequestCancellation, null, requestCancellation);
            _gate.Release();
        }
    }

    public async Task StopAsync()
    {
        try { Volatile.Read(ref _activeRequestCancellation)?.Cancel(); }
        catch (ObjectDisposedException) { }
        await _gate.WaitAsync();
        try { StopWorkerCore(); }
        finally { _gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _gate.Dispose();
    }

    private async Task StartWorkerAsync(
        ExtractionSuggestionModel model,
        string checkpointHash,
        CancellationToken cancellationToken)
    {
        StopWorkerCore();
        if (!File.Exists(paths.VirtualEnvironmentPython))
            throw new InvalidOperationException(
                "The Deckino training runtime is not installed. Prepare the extraction environment before enabling suggestions.");
        var startInfo = runner.CreateStartInfo(paths.VirtualEnvironmentPython,
        [
            "-m", "deckino_training", "extraction-suggestion-worker",
            "--checkpoint", model.CheckpointPath,
            "--thresholds", model.ThresholdsPath,
            "--device", "cpu",
        ], redirectStandardInput: true);
        var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new InvalidOperationException("Could not start the extraction suggestion worker.");
        _worker = process;
        _stderrPump = DrainErrorsAsync(process);
        try
        {
            var line = await process.StandardOutput.ReadLineAsync(cancellationToken).AsTask()
                .WaitAsync(TimeSpan.FromSeconds(60), cancellationToken);
            if (line is null) throw new InvalidOperationException("The extraction suggestion worker did not become ready.");
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.GetProperty("event").GetString() != "extraction_suggestion_ready"
                || root.GetProperty("model_version").GetString() != model.ModelVersion
                || root.GetProperty("checkpoint_sha256").GetString() != checkpointHash)
                throw new InvalidOperationException("The extraction suggestion worker loaded an unexpected model.");
            _workerModelVersion = model.ModelVersion;
            _workerCheckpointHash = checkpointHash;
            applicationLog.Information("corner-suggestion",
                $"Loaded {model.ModelVersion} ({checkpointHash[..12]}) for persistent CPU suggestions.");
        }
        catch
        {
            StopWorkerCore();
            throw;
        }
    }

    private async Task DrainErrorsAsync(Process process)
    {
        try
        {
            while (await process.StandardError.ReadLineAsync() is { } line)
                applicationLog.Information("corner-suggestion-python", line);
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    private void StopWorkerCore()
    {
        var process = Interlocked.Exchange(ref _worker, null);
        _workerModelVersion = null;
        _workerCheckpointHash = null;
        _stderrPump = null;
        if (process is null) return;
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
        }
        process.Dispose();
    }

    private static IReadOnlyList<NormalizedPoint>? ParseCorners(JsonElement result)
    {
        if (!result.TryGetProperty("corners", out var values) || values.ValueKind == JsonValueKind.Null) return null;
        if (values.ValueKind != JsonValueKind.Array || values.GetArrayLength() != 4)
            throw new InvalidDataException("The extraction worker returned an invalid corner count.");
        var points = values.EnumerateArray()
            .Select(value => new NormalizedPoint(
                value.GetProperty("x").GetDouble(),
                value.GetProperty("y").GetDouble()))
            .ToArray();
        if (points.Any(point => !double.IsFinite(point.X) || !double.IsFinite(point.Y)
                                || point.X is < 0 or > 1 || point.Y is < 0 or > 1))
            throw new InvalidDataException("The extraction worker returned non-finite or out-of-bounds corners.");
        return points;
    }

    private static async Task<string> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }
}
