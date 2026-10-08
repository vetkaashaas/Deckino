using System.IO;
using System.Text.Json;

namespace Deckino.Toolbox.Services;

// Frozen real-photo benchmarks for the artwork model (training/src/deckino_training/artwork_benchmark.py). The
// benchmark files ship in training/benchmarks; each model's result is artifacts/<model>/benchmarks/<name>.json.
public sealed class ArtworkBenchmarkService(TrainingPaths paths, PythonProcessRunner runner)
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public string BenchmarksRoot => paths.BenchmarksRoot;

    public IReadOnlyList<string> BenchmarkNames() => Directory.Exists(BenchmarksRoot)
        ? Directory.EnumerateFiles(BenchmarksRoot, "artwork-*.json").Select(Path.GetFileNameWithoutExtension).Order().ToArray()!
        : [];

    // Every artwork model on this PC that can be benchmarked (it has a phone export) or already was, oldest first.
    // Runs are named artwork-run-<UTC timestamp>, so name order is training order; the fixed-name models that
    // predate run names (mobilenetv3s-…) come first.
    public IReadOnlyList<ArtworkBenchmarkModel> Models(string benchmark)
    {
        if (!Directory.Exists(paths.ArtifactsRoot)) return [];
        return Directory.EnumerateDirectories(paths.ArtifactsRoot)
            .Select(Path.GetFileName)
            .Where(name => !name!.StartsWith('.') && !name.Contains(".replaced-", StringComparison.Ordinal))
            .OrderBy(name => name!.StartsWith("artwork-run-", StringComparison.Ordinal))
            .ThenBy(name => name, StringComparer.Ordinal)
            .Select(name => new ArtworkBenchmarkModel(
                name!,
                File.Exists(Path.Combine(paths.MobileArtworkRoot, name!, "mobile-manifest.json")),
                LoadResult(name!, benchmark)))
            .Where(model => model.HasPhoneExport || model.Result is not null)
            .ToArray();
    }

    // A result that cannot be read (half written, another schema) counts as not run, so it can be re-run and the
    // other models still show.
    public ArtworkBenchmarkResult? LoadResult(string modelVersion, string benchmark)
    {
        var path = Path.Combine(paths.ArtifactRoot(modelVersion), "benchmarks", benchmark + ".json");
        if (!File.Exists(path)) return null;
        try
        {
            var result = JsonSerializer.Deserialize<ArtworkBenchmarkResult>(File.ReadAllText(path), JsonOptions);
            return result is { ResultSchemaVersion: 1, Summary: not null, Photos: not null } ? result : null;
        }
        catch (Exception error) when (error is JsonException or IOException)
        {
            return null;
        }
    }

    public async Task RunAsync(string modelVersion, string benchmark, Action<int, int>? onProgress,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(paths.VirtualEnvironmentPython))
            throw new InvalidOperationException("The Deckino training runtime is not installed; prepare it on the Runner page first.");
        var result = await runner.RunAsync(
            paths.VirtualEnvironmentPython,
            ["-m", "deckino_training", "benchmark-artwork", "--training-root", paths.TrainingRoot,
                "--model-version", modelVersion, "--benchmark", benchmark],
            $"{modelVersion}-benchmark-{benchmark}",
            (_, parsed) =>
            {
                if (parsed is { } line && line.TryGetProperty("event", out var name)
                    && name.GetString() == "artwork_benchmark_progress")
                    onProgress?.Invoke(line.GetProperty("done").GetInt32(), line.GetProperty("photos").GetInt32());
            },
            cancellationToken);
        if (result.ExitCode != 0)
            throw new InvalidOperationException(
                $"Benchmarking {modelVersion} failed (exit {result.ExitCode}); see {Path.GetFileName(result.LogPath)}.");
    }
}

public sealed record ArtworkBenchmarkModel(string ModelVersion, bool HasPhoneExport, ArtworkBenchmarkResult? Result);

public sealed record ArtworkBenchmarkResult(
    int ResultSchemaVersion,
    string Benchmark,
    string ModelVersion,
    ArtworkBenchmarkSummary Summary,
    IReadOnlyList<ArtworkBenchmarkPhoto> Photos);

public sealed record ArtworkBenchmarkSummary(
    int Photos,
    int Cards,
    double Top1,
    double Top5,
    double CardTop1,
    double Accepted,
    double AcceptedCorrect,
    double AcceptedWrong,
    double? MedianScoreRight,
    double? MedianMarginRight,
    // Benchmark photos whose Card Identification label changed after freezing (still scored by the frozen one).
    int LabelsChanged);

public sealed record ArtworkBenchmarkPhoto(
    string Photo,
    string OracleId,
    string CardName,
    int? Rank,
    bool Accepted,
    double Score,
    double? Margin,
    IReadOnlyList<ArtworkBenchmarkCandidate> Candidates);

public sealed record ArtworkBenchmarkCandidate(string OracleId, string CardName, double Score);
