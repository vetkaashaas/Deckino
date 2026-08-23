using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Deckino.Tools.Services;

public sealed class TrainingResultExporter(TrainingPaths paths)
{
    private static readonly string[] RequiredArtifacts =
        ["best.pt", "last.pt", "labels.json", "config.json", "thresholds.json", "evaluation.json"];

    public Task<string> ExportAsync(string modelVersion, CancellationToken cancellationToken) =>
        ExportAsync(modelVersion, smoke: false, cancellationToken);

    public async Task<string> ExportAsync(
        string modelVersion,
        bool smoke,
        CancellationToken cancellationToken)
    {
        var artifactRoot = paths.ArtifactRoot(modelVersion);
        foreach (var name in RequiredArtifacts)
        {
            if (!File.Exists(Path.Combine(artifactRoot, name)))
            {
                throw new InvalidOperationException($"Cannot export: {name} is missing.");
            }
        }
        var outputRoot = Path.Combine(paths.TrainingRoot, "results");
        Directory.CreateDirectory(outputRoot);
        var zipPath = Path.Combine(
            outputRoot,
            $"deckino-{(smoke ? "smoke-" : string.Empty)}results-{Sanitize(modelVersion)}-{DateTime.UtcNow:yyyyMMddTHHmmssfffZ}.zip");
        var sources = RequiredArtifacts
            .Select(name => (Path: Path.Combine(artifactRoot, name), Entry: $"artifacts/{name}"))
            .ToList();
        var cameraReport = Path.Combine(artifactRoot, "camera-report.json");
        if (File.Exists(cameraReport))
        {
            sources.Add((cameraReport, "artifacts/camera-report.json"));
        }
        if (smoke)
        {
            var smokeReport = Path.Combine(artifactRoot, "smoke-report.json");
            if (!File.Exists(smokeReport))
            {
                throw new InvalidOperationException("Cannot export smoke results: smoke-report.json is missing.");
            }
            sources.Add((smokeReport, "artifacts/smoke-report.json"));
        }
        if (Directory.Exists(paths.LogsRoot))
        {
            sources.AddRange(Directory.EnumerateFiles(paths.LogsRoot, "*.log")
                .Where(path => Path.GetFileName(path).Contains(modelVersion, StringComparison.OrdinalIgnoreCase))
                .Select(path => (path, $"logs/{Path.GetFileName(path)}")));
        }

        var checksums = new SortedDictionary<string, string>(StringComparer.Ordinal);
        await using var zipStream = File.Create(zipPath);
        using var archive = new ZipArchive(zipStream, ZipArchiveMode.Create, leaveOpen: false);
        foreach (var source in sources.OrderBy(item => item.Entry, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var bytes = source.Entry.StartsWith("logs/", StringComparison.Ordinal)
                || source.Entry.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                ? Encoding.UTF8.GetBytes(RedactAbsolutePaths(
                    await File.ReadAllTextAsync(source.Path, cancellationToken)))
                : await File.ReadAllBytesAsync(source.Path, cancellationToken);
            checksums[source.Entry] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            var entry = archive.CreateEntry(source.Entry, CompressionLevel.Optimal);
            await using var entryStream = entry.Open();
            await entryStream.WriteAsync(bytes, cancellationToken);
        }
        var metadata = JsonSerializer.SerializeToUtf8Bytes(new
        {
            export_schema_version = 1,
            artifact_schema_version = 3,
            model_version = modelVersion,
            smoke,
            created_utc = DateTime.UtcNow.ToString("O"),
        }, new JsonSerializerOptions { WriteIndented = true });
        checksums["metadata.json"] = Convert.ToHexString(SHA256.HashData(metadata)).ToLowerInvariant();
        await WriteEntryAsync(archive, "metadata.json", metadata, cancellationToken);
        var checksumText = string.Join("\n", checksums.Select(pair => $"{pair.Value}  {pair.Key}")) + "\n";
        await WriteEntryAsync(archive, "SHA256SUMS", Encoding.UTF8.GetBytes(checksumText), cancellationToken);
        return zipPath;
    }

    public async Task<ZipVerificationResult> VerifyAsync(
        string zipPath,
        bool requireSmokeReport,
        CancellationToken cancellationToken)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var payloadEntries = archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)).ToArray();
        if (payloadEntries.Select(entry => entry.FullName).Distinct(StringComparer.Ordinal).Count()
            != payloadEntries.Length)
        {
            throw new InvalidDataException("Result ZIP contains duplicate entry names.");
        }
        var entries = payloadEntries.ToDictionary(entry => entry.FullName, StringComparer.Ordinal);
        if (!entries.TryGetValue("SHA256SUMS", out var checksumEntry))
        {
            throw new InvalidDataException("Result ZIP does not contain SHA256SUMS.");
        }

        using var reader = new StreamReader(checksumEntry.Open(), Encoding.UTF8);
        var checksumText = await reader.ReadToEndAsync(cancellationToken);
        var expected = ParseChecksums(checksumText);
        var actualPayloadNames = entries.Keys
            .Where(name => !name.Equals("SHA256SUMS", StringComparison.Ordinal))
            .ToHashSet(StringComparer.Ordinal);
        if (!actualPayloadNames.SetEquals(expected.Keys))
        {
            throw new InvalidDataException("Result ZIP contains missing or additional unchecked entries.");
        }
        if (requireSmokeReport && !expected.ContainsKey("artifacts/smoke-report.json"))
        {
            throw new InvalidDataException("Smoke result ZIP does not contain smoke-report.json.");
        }
        foreach (var pair in expected)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await using var stream = entries[pair.Key].Open();
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken))
                .ToLowerInvariant();
            if (!actual.Equals(pair.Value, StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Checksum mismatch for {pair.Key}.");
            }
        }
        return new ZipVerificationResult(zipPath, expected.Count);
    }

    public ZipVerificationResult Verify(string zipPath, bool requireSmokeReport)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var payloadEntries = archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)).ToArray();
        if (payloadEntries.Select(entry => entry.FullName).Distinct(StringComparer.Ordinal).Count()
            != payloadEntries.Length)
        {
            throw new InvalidDataException("Result ZIP contains duplicate entry names.");
        }
        var entries = payloadEntries.ToDictionary(entry => entry.FullName, StringComparer.Ordinal);
        if (!entries.TryGetValue("SHA256SUMS", out var checksumEntry))
        {
            throw new InvalidDataException("Result ZIP does not contain SHA256SUMS.");
        }

        using var reader = new StreamReader(checksumEntry.Open(), Encoding.UTF8);
        var expected = ParseChecksums(reader.ReadToEnd());
        var actualPayloadNames = entries.Keys
            .Where(name => !name.Equals("SHA256SUMS", StringComparison.Ordinal))
            .ToHashSet(StringComparer.Ordinal);
        if (!actualPayloadNames.SetEquals(expected.Keys))
        {
            throw new InvalidDataException("Result ZIP contains missing or additional unchecked entries.");
        }
        if (requireSmokeReport && !expected.ContainsKey("artifacts/smoke-report.json"))
        {
            throw new InvalidDataException("Smoke result ZIP does not contain smoke-report.json.");
        }
        foreach (var pair in expected)
        {
            using var stream = entries[pair.Key].Open();
            var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            if (!actual.Equals(pair.Value, StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Checksum mismatch for {pair.Key}.");
            }
        }
        return new ZipVerificationResult(zipPath, expected.Count);
    }

    private static Dictionary<string, string> ParseChecksums(string value)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (line.Length < 67 || line[64..66] != "  ")
            {
                throw new InvalidDataException("SHA256SUMS contains an invalid line.");
            }
            var hash = line[..64];
            var name = line[66..];
            if (!Regex.IsMatch(hash, "^[0-9a-f]{64}$") || string.IsNullOrWhiteSpace(name)
                || name.Contains("..", StringComparison.Ordinal) || !result.TryAdd(name, hash))
            {
                throw new InvalidDataException("SHA256SUMS contains an invalid or duplicate entry.");
            }
        }
        if (result.Count == 0) throw new InvalidDataException("SHA256SUMS is empty.");
        return result;
    }

    private static async Task WriteEntryAsync(
        ZipArchive archive,
        string name,
        byte[] bytes,
        CancellationToken cancellationToken)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        await using var stream = entry.Open();
        await stream.WriteAsync(bytes, cancellationToken);
    }

    private static string Sanitize(string value) => string.Concat(value.Select(character =>
        Path.GetInvalidFileNameChars().Contains(character) ? '_' : character));

    private static string RedactAbsolutePaths(string value) => Regex.Replace(
        value,
        @"(?i)\b[A-Z]:(?:\\+|/+)[^\""\r\n]*",
        "<ABSOLUTE_PATH>");
}

public sealed record ZipVerificationResult(string ZipPath, int VerifiedEntries);
