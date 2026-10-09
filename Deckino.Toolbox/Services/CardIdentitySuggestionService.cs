using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace Deckino.Toolbox.Services;

public sealed record CardIdentitySuggestion(string ModelVersion, IReadOnlyList<IdentityCandidate> Candidates);

// Keeps the current artwork model loaded in a Python worker while Card Identification is open, so "Suggest cards"
// answers in about a second. A newly imported model is picked up on the next request.
public sealed class CardIdentitySuggestionService(
    TrainingPaths paths,
    PythonProcessRunner runner,
    TrainingResultExporter exporter,
    ApplicationLogService applicationLog) : IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Process? _worker;
    private string? _workerPointer;

    // Loads the model ahead of the first click; a failure here is reported again by that click.
    public async Task WarmUpAsync()
    {
        await _gate.WaitAsync();
        try { await EnsureWorkerAsync(); }
        catch (Exception error) { applicationLog.Information("card-suggestion", $"Warm-up skipped: {error.Message}"); }
        finally { _gate.Release(); }
    }

    public async Task<CardIdentitySuggestion> SuggestAsync(string imagePath, IReadOnlyList<NormalizedPoint> corners)
    {
        await _gate.WaitAsync();
        try
        {
            await EnsureWorkerAsync();
            var requestId = Guid.NewGuid().ToString("N");
            await _worker!.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new
            {
                request_id = requestId,
                image_path = Path.GetFullPath(imagePath),
                corners = corners.Select(point => new { x = point.X, y = point.Y }),
            }));
            await _worker.StandardInput.FlushAsync();
            while (true)
            {
                var line = await _worker.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30))
                    ?? throw new InvalidOperationException("The card suggestion worker stopped unexpectedly.");
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (!root.TryGetProperty("request_id", out var id) || id.GetString() != requestId) continue;
                if (root.GetProperty("event").GetString() == "card_identity_suggestion_error")
                    throw new InvalidOperationException(root.GetProperty("message").GetString());
                return new CardIdentitySuggestion(
                    root.GetProperty("model_version").GetString()!,
                    root.GetProperty("candidates").Deserialize<IdentityCandidate[]>()!);
            }
        }
        catch
        {
            // A timed-out reply could still arrive; a fresh worker cannot hand it to the next photo.
            StopWorker();
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task StopAsync()
    {
        await _gate.WaitAsync();
        try { StopWorker(); }
        finally { _gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _gate.Dispose();
    }

    private async Task EnsureWorkerAsync()
    {
        var pointer = exporter.ReadCurrentArtworkPointer()?.ModelVersion;
        if (_worker is { HasExited: false } && _workerPointer == pointer) return;
        StopWorker();
        if (!File.Exists(paths.VirtualEnvironmentPython))
            throw new InvalidOperationException("The Deckino training runtime is not installed; prepare it on the Runner page first.");
        List<string> arguments = ["-m", "deckino_training", "card-identity-worker", "--training-root", paths.TrainingRoot];
        if (pointer is not null) arguments.AddRange(["--model-version", pointer]);
        var process = new Process { StartInfo = runner.CreateStartInfo(paths.VirtualEnvironmentPython, arguments, redirectStandardInput: true) };
        if (!process.Start()) throw new InvalidOperationException("Could not start the card suggestion worker.");
        _worker = process;
        _ = DrainErrorsAsync(process);
        try
        {
            var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(120))
                ?? throw new InvalidOperationException("The card suggestion worker did not start; see the application log.");
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.GetProperty("event").GetString() != "card_identity_worker_ready")
                throw new InvalidOperationException(root.TryGetProperty("message", out var message)
                    ? message.GetString() : "The card suggestion worker did not start.");
            _workerPointer = pointer;
            applicationLog.Information("card-suggestion", $"Loaded {root.GetProperty("model_version").GetString()} for card suggestions.");
        }
        catch
        {
            StopWorker();
            throw;
        }
    }

    private async Task DrainErrorsAsync(Process process)
    {
        try
        {
            while (await process.StandardError.ReadLineAsync() is { } line)
                applicationLog.Information("card-suggestion-python", line);
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    private void StopWorker()
    {
        var process = Interlocked.Exchange(ref _worker, null);
        _workerPointer = null;
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
}
