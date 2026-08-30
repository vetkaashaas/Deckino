using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Deckino.Tools.Services;

public enum VideoFramePreset
{
    Fewer,
    Automatic,
    More,
}

public sealed record VideoProbeResult(
    string SourcePath,
    TimeSpan Duration,
    int Width,
    int Height,
    double SourceFramesPerSecond,
    string Codec);

public sealed record VideoImportProgress(
    int FramesWritten,
    TimeSpan Processed,
    double Percent);

public sealed record VideoFrameImportResult(
    string BatchRoot,
    int ExtractedFrames,
    double RequestedFramesPerSecond,
    double EffectiveFramesPerSecond);

public sealed class VideoFrameImportService
{
    private const int MaximumImportedShortSide = CameraImageImportService.MaximumImportedShortSide;
    private const int MaximumImportedLongSide = CameraImageImportService.MaximumImportedLongSide;
    private readonly CameraAnnotationStore _store;
    private readonly string _runtimeRoot;

    public VideoFrameImportService(CameraAnnotationStore store, string? runtimeRoot = null)
    {
        _store = store;
        _runtimeRoot = runtimeRoot ?? Path.Combine(AppContext.BaseDirectory, "tools", "ffmpeg", "win-x64");
    }

    public string FfmpegPath => Path.Combine(_runtimeRoot, "ffmpeg.exe");
    public string FfprobePath => Path.Combine(_runtimeRoot, "ffprobe.exe");
    public bool IsRuntimeAvailable => File.Exists(FfmpegPath) && File.Exists(FfprobePath);
    public string RuntimeStatus => IsRuntimeAvailable
        ? "Bundled FFmpeg runtime ready."
        : $"Bundled FFmpeg runtime is missing from {_runtimeRoot}. Run scripts\\fetch-ffmpeg.ps1 and rebuild Deckino.Tools.";

    public static double FramesPerSecond(VideoFramePreset preset) => preset switch
    {
        VideoFramePreset.Fewer => 5,
        VideoFramePreset.More => 15,
        _ => 10,
    };

    public static double EffectiveFramesPerSecond(VideoProbeResult probe, VideoFramePreset preset)
    {
        var requested = FramesPerSecond(preset);
        return probe.SourceFramesPerSecond > 0
            ? Math.Min(requested, probe.SourceFramesPerSecond)
            : requested;
    }

    public static int EstimateFrameCount(VideoProbeResult probe, VideoFramePreset preset) =>
        Math.Max(1, (int)Math.Ceiling(probe.Duration.TotalSeconds * EffectiveFramesPerSecond(probe, preset)));

    public async Task<VideoProbeResult> ProbeAsync(string sourcePath, CancellationToken cancellationToken)
    {
        EnsureRuntime();
        var fullPath = Path.GetFullPath(sourcePath);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("Video file not found.", fullPath);

        var result = await RunProcessAsync(
            FfprobePath,
            [
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,codec_name:format=duration",
                "-of", "json",
                fullPath,
            ],
            progress: null,
            duration: null,
            cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"FFprobe could not read the selected video. {result.ErrorSummary}");
        }

        try
        {
            using var document = JsonDocument.Parse(result.StandardOutput);
            var root = document.RootElement;
            var stream = root.GetProperty("streams").EnumerateArray().FirstOrDefault();
            if (stream.ValueKind == JsonValueKind.Undefined)
                throw new InvalidOperationException("The selected file does not contain a video stream.");

            var durationText = root.GetProperty("format").GetProperty("duration").GetString();
            if (!double.TryParse(durationText, NumberStyles.Float, CultureInfo.InvariantCulture, out var durationSeconds)
                || durationSeconds <= 0)
                throw new InvalidOperationException("The selected video has no usable duration metadata.");

            var framesPerSecond = ParseFrameRate(stream, "avg_frame_rate");
            if (framesPerSecond <= 0) framesPerSecond = ParseFrameRate(stream, "r_frame_rate");
            return new VideoProbeResult(
                fullPath,
                TimeSpan.FromSeconds(durationSeconds),
                stream.GetProperty("width").GetInt32(),
                stream.GetProperty("height").GetInt32(),
                framesPerSecond,
                stream.TryGetProperty("codec_name", out var codec) ? codec.GetString() ?? "unknown" : "unknown");
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException("FFprobe returned invalid video metadata.", error);
        }
    }

    public async Task<VideoFrameImportResult> ImportAsync(
        VideoProbeResult probe,
        VideoFramePreset preset,
        IProgress<VideoImportProgress>? progress,
        CancellationToken cancellationToken)
    {
        EnsureRuntime();
        Directory.CreateDirectory(_store.ImportsRoot);
        var batchId = CreateBatchId(_store.ImportsRoot);
        var finalBatchRoot = Path.Combine(_store.ImportsRoot, batchId);
        var stagingRoot = Path.Combine(Path.GetDirectoryName(_store.ImportsRoot)!, ".video-import-staging");
        var pendingBatchRoot = Path.Combine(stagingRoot, $"video-{Guid.NewGuid():N}");
        var importedFolder = Sanitize(Path.GetFileNameWithoutExtension(probe.SourcePath));
        var outputRoot = Path.Combine(pendingBatchRoot, importedFolder);
        var outputPattern = Path.Combine(outputRoot, "frame_%06d.jpg");
        var requestedFramesPerSecond = FramesPerSecond(preset);
        var effectiveFramesPerSecond = EffectiveFramesPerSecond(probe, preset);

        try
        {
            Directory.CreateDirectory(outputRoot);
            var frameRate = effectiveFramesPerSecond.ToString("0.###", CultureInfo.InvariantCulture);
            var scale = BuildScaleFilter();
            var result = await RunProcessAsync(
                FfmpegPath,
                [
                    "-hide_banner", "-nostdin", "-y",
                    "-i", probe.SourcePath,
                    "-map", "0:v:0",
                    "-vf", $"fps={frameRate},{scale}",
                    "-q:v", "2",
                    "-start_number", "1",
                    "-progress", "pipe:1",
                    "-nostats",
                    outputPattern,
                ],
                progress,
                probe.Duration,
                cancellationToken);
            if (result.ExitCode != 0)
                throw new InvalidOperationException($"FFmpeg could not extract the video frames. {result.ErrorSummary}");

            var extractedFrames = Directory.EnumerateFiles(outputRoot, "frame_*.jpg", SearchOption.TopDirectoryOnly).Count();
            if (extractedFrames == 0) throw new InvalidOperationException("FFmpeg completed without producing any frames.");

            var sourceGroup = $"{batchId}/{importedFolder}";
            var source = new CameraImportSource(probe.SourcePath, importedFolder, sourceGroup);
            var descriptor = new CameraImportDescriptor(2, batchId, DateTimeOffset.UtcNow, null, [source])
            {
                Video = new VideoImportMetadata(
                    probe.SourcePath,
                    probe.Duration.TotalSeconds,
                    probe.SourceFramesPerSecond,
                    requestedFramesPerSecond,
                    effectiveFramesPerSecond,
                    extractedFrames),
            };
            CameraAnnotationStore.WriteAtomic(
                Path.Combine(pendingBatchRoot, ".deckino-import.json"), descriptor, overwrite: false);
            Directory.Move(pendingBatchRoot, finalBatchRoot);
            progress?.Report(new VideoImportProgress(extractedFrames, probe.Duration, 100));
            return new VideoFrameImportResult(
                finalBatchRoot, extractedFrames, requestedFramesPerSecond, effectiveFramesPerSecond);
        }
        catch
        {
            DeleteStagedBatch(stagingRoot, pendingBatchRoot);
            throw;
        }
        finally
        {
            DeleteEmptyStagingRoot(stagingRoot);
        }
    }

    private async Task<ProcessResult> RunProcessAsync(
        string executable,
        IReadOnlyList<string> arguments,
        IProgress<VideoImportProgress>? progress,
        TimeSpan? duration,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = _runtimeRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new InvalidOperationException($"Could not start {Path.GetFileName(executable)}.");

        var standardOutput = new List<string>();
        var errorLines = new Queue<string>();
        var outputTask = ReadOutputAsync(process.StandardOutput, standardOutput, progress, duration, cancellationToken);
        var errorTask = ReadErrorsAsync(process.StandardError, errorLines, cancellationToken);
        try
        {
            await process.WaitForExitAsync(cancellationToken);
            await Task.WhenAll(outputTask, errorTask);
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            await process.WaitForExitAsync(CancellationToken.None);
            throw;
        }
        return new ProcessResult(process.ExitCode, string.Join(Environment.NewLine, standardOutput),
            string.Join(" ", errorLines));
    }

    private static async Task ReadOutputAsync(
        StreamReader reader,
        ICollection<string> lines,
        IProgress<VideoImportProgress>? progress,
        TimeSpan? duration,
        CancellationToken cancellationToken)
    {
        var frames = 0;
        var processed = TimeSpan.Zero;
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            lines.Add(line);
            if (line.StartsWith("frame=", StringComparison.Ordinal)
                && int.TryParse(line.AsSpan(6), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedFrames))
                frames = parsedFrames;
            else if (line.StartsWith("out_time_us=", StringComparison.Ordinal)
                     && long.TryParse(line.AsSpan(12), NumberStyles.Integer, CultureInfo.InvariantCulture, out var microseconds))
                processed = TimeSpan.FromTicks(microseconds * 10);

            if (progress is not null && duration is { TotalSeconds: > 0 })
            {
                var percent = Math.Clamp(processed.TotalSeconds / duration.Value.TotalSeconds * 100, 0, 99.5);
                progress.Report(new VideoImportProgress(frames, processed, percent));
            }
        }
    }

    private static async Task ReadErrorsAsync(
        StreamReader reader,
        Queue<string> lines,
        CancellationToken cancellationToken)
    {
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            lines.Enqueue(line.Trim());
            while (lines.Count > 12) lines.Dequeue();
        }
    }

    private static double ParseFrameRate(JsonElement stream, string propertyName)
    {
        if (!stream.TryGetProperty(propertyName, out var property)) return 0;
        var parts = (property.GetString() ?? string.Empty).Split('/');
        if (parts.Length != 2
            || !double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var numerator)
            || !double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var denominator)
            || denominator == 0)
            return 0;
        return numerator / denominator;
    }

    private static string BuildScaleFilter()
    {
        var scale = $"min(1\\,min({MaximumImportedShortSide}/min(iw\\,ih)\\,{MaximumImportedLongSide}/max(iw\\,ih)))";
        return $"scale=w=max(2\\,trunc(iw*{scale}/2)*2):h=max(2\\,trunc(ih*{scale}/2)*2):flags=lanczos";
    }

    private static string CreateBatchId(string importsRoot)
    {
        var baseId = DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss", CultureInfo.InvariantCulture);
        for (var suffix = 1; ; suffix++)
        {
            var candidate = suffix == 1 ? baseId : $"{baseId}-{suffix}";
            if (!Directory.Exists(Path.Combine(importsRoot, candidate))) return candidate;
        }
    }

    private static string Sanitize(string value)
    {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var clean = new string(value.Select(character => invalid.Contains(character) ? '_' : character).ToArray()).Trim();
        return string.IsNullOrWhiteSpace(clean) ? "video" : clean;
    }

    private void EnsureRuntime()
    {
        if (!IsRuntimeAvailable) throw new InvalidOperationException(RuntimeStatus);
    }

    private static void DeleteStagedBatch(string stagingRoot, string pendingBatchRoot)
    {
        if (!Directory.Exists(pendingBatchRoot)) return;
        var resolvedStagingRoot = Path.GetFullPath(stagingRoot).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var candidate = Path.GetFullPath(pendingBatchRoot);
        if (!candidate.StartsWith(resolvedStagingRoot, StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(candidate).StartsWith("video-", StringComparison.Ordinal))
            throw new InvalidOperationException("Refusing to remove an unexpected video import directory.");
        Directory.Delete(candidate, recursive: true);
    }

    private static void DeleteEmptyStagingRoot(string stagingRoot)
    {
        if (!Directory.Exists(stagingRoot)
            || Directory.EnumerateFileSystemEntries(stagingRoot).Any())
            return;
        Directory.Delete(stagingRoot, recursive: false);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
    }

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string ErrorSummary);
}
