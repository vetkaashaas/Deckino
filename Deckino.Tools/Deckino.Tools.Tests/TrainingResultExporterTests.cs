using System.IO.Compression;
using System.Text.Json;
using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class TrainingResultExporterTests
{
    [Fact]
    public async Task ExportsAllowListedArtifactsLogsAndChecksums()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-export-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var modelVersion = "model-v3";
            var artifactRoot = paths.ArtifactRoot(modelVersion);
            Directory.CreateDirectory(artifactRoot);
            foreach (var name in new[] { "best.pt", "last.pt", "labels.json", "config.json", "thresholds.json", "evaluation.json" })
            {
                await File.WriteAllTextAsync(Path.Combine(artifactRoot, name), $"content:{name}");
            }
            Directory.CreateDirectory(paths.LogsRoot);
            await File.WriteAllTextAsync(
                Path.Combine(paths.LogsRoot, $"run-{modelVersion}-train.log"),
                $"training artifact_root={artifactRoot}");
            await File.WriteAllTextAsync(Path.Combine(paths.LogsRoot, "packages-install.log"), "private install details");

            var zipPath = await new TrainingResultExporter(paths).ExportAsync(modelVersion, CancellationToken.None);
            using var archive = ZipFile.OpenRead(zipPath);
            var names = archive.Entries.Select(entry => entry.FullName).ToHashSet();

            Assert.Contains("artifacts/best.pt", names);
            Assert.Contains("logs/run-model-v3-train.log", names);
            Assert.Contains("SHA256SUMS", names);
            Assert.DoesNotContain("logs/packages-install.log", names);
            Assert.DoesNotContain(names, name => name.Contains("data/", StringComparison.OrdinalIgnoreCase));
            using var reader = new StreamReader(archive.GetEntry("logs/run-model-v3-train.log")!.Open());
            var exportedLog = await reader.ReadToEndAsync();
            Assert.DoesNotContain(root, exportedLog, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("<ABSOLUTE_PATH>", exportedLog);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SmokeExportIncludesReportAndRejectsUncheckedEntries()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-smoke-export-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            const string modelVersion = "smoke-model-v3";
            var artifactRoot = paths.ArtifactRoot(modelVersion);
            Directory.CreateDirectory(artifactRoot);
            foreach (var name in new[]
                     {
                         "best.pt", "last.pt", "labels.json", "config.json", "thresholds.json",
                         "evaluation.json", "smoke-report.json",
                     })
            {
                var content = name.EndsWith(".json", StringComparison.Ordinal)
                    ? $"{{\"name\":\"{name}\",\"path\":\"C:\\\\Work\\\\private\"}}"
                    : $"content:{name}";
                await File.WriteAllTextAsync(Path.Combine(artifactRoot, name), content);
            }
            var exporter = new TrainingResultExporter(paths);
            var zipPath = await exporter.ExportAsync(modelVersion, smoke: true, CancellationToken.None);
            var verified = await exporter.VerifyAsync(zipPath, requireSmokeReport: true, CancellationToken.None);
            Assert.True(verified.VerifiedEntries >= 8);
            Assert.Equal(verified.VerifiedEntries, exporter.Verify(zipPath, requireSmokeReport: true).VerifiedEntries);
            Assert.StartsWith("deckino-smoke-results-", Path.GetFileName(zipPath), StringComparison.Ordinal);
            using (var archive = ZipFile.OpenRead(zipPath))
            using (var reader = new StreamReader(archive.GetEntry("artifacts/smoke-report.json")!.Open()))
            using (var document = JsonDocument.Parse(await reader.ReadToEndAsync()))
            {
                Assert.Equal("<ABSOLUTE_PATH>", document.RootElement.GetProperty("path").GetString());
            }

            using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Update))
            {
                using var writer = new StreamWriter(archive.CreateEntry("unchecked.txt").Open());
                await writer.WriteAsync("not checksummed");
            }
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                exporter.VerifyAsync(zipPath, requireSmokeReport: true, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
