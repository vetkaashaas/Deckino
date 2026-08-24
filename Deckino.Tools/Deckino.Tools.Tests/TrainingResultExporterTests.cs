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
            using (var archive = ZipFile.OpenRead(zipPath))
            {
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
            var exporter = new TrainingResultExporter(paths);
            var verified = await exporter.VerifyAsync(zipPath, CancellationToken.None);
            Assert.Equal(verified.VerifiedEntries, exporter.Verify(zipPath).VerifiedEntries);

            using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Update))
            {
                using var writer = new StreamWriter(archive.CreateEntry("unchecked.txt").Open());
                await writer.WriteAsync("not checksummed");
            }
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                exporter.VerifyAsync(zipPath, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ProductionExportRequiresIdentityReportAndVerifiesIt()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-identity-export-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            const string modelVersion = "mobilenetv3s-512-v3";
            var artifactRoot = paths.ArtifactRoot(modelVersion);
            Directory.CreateDirectory(artifactRoot);
            foreach (var name in new[]
                     {
                         "best.pt", "last.pt", "labels.json", "config.json", "thresholds.json",
                         "evaluation.json", "identity-report.json",
                     })
            {
                await File.WriteAllTextAsync(
                    Path.Combine(artifactRoot, name),
                    name.EndsWith(".json", StringComparison.Ordinal) ? "{}" : name);
            }

            var exporter = new TrainingResultExporter(paths);
            var zipPath = await exporter.ExportIdentityAsync(modelVersion, CancellationToken.None);
            var verified = await exporter.VerifyIdentityAsync(zipPath, CancellationToken.None);

            Assert.True(verified.VerifiedEntries >= 8);
            using var archive = ZipFile.OpenRead(zipPath);
            Assert.NotNull(archive.GetEntry("artifacts/identity-report.json"));
            Assert.StartsWith("deckino-results-", Path.GetFileName(zipPath), StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ArtworkExportContainsOnlyVersionFourRetrievalPayload()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-artwork-export-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            const string modelVersion = "mobilenetv3s-512-art-v4";
            var artifactRoot = paths.ArtifactRoot(modelVersion);
            var indexRoot = Path.Combine(artifactRoot, "index");
            Directory.CreateDirectory(indexRoot);
            foreach (var relative in new[]
                     {
                         "identity-report.json", "retrieval-report.json", "artwork-thresholds.json",
                         "retrieval-failures.jsonl", Path.Combine("index", "index-metadata.json"),
                         Path.Combine("index", "index-labels.json"), Path.Combine("index", "index.f32"),
                     })
            {
                var path = Path.Combine(artifactRoot, relative);
                await File.WriteAllTextAsync(path, relative.EndsWith(".json", StringComparison.Ordinal)
                    ? "{}" : relative);
            }
            await File.WriteAllTextAsync(Path.Combine(artifactRoot, "embedding.pt"), "checkpoint");

            var exporter = new TrainingResultExporter(paths);
            var zipPath = await exporter.ExportArtworkIdentityAsync(
                modelVersion, CancellationToken.None);
            var verified = await exporter.VerifyIdentityAsync(zipPath, CancellationToken.None);

            Assert.True(verified.VerifiedEntries >= 9);
            using var archive = ZipFile.OpenRead(zipPath);
            Assert.NotNull(archive.GetEntry("artifacts/embedding.pt"));
            Assert.NotNull(archive.GetEntry("artifacts/index/index.f32"));
            using var metadata = JsonDocument.Parse(
                await new StreamReader(archive.GetEntry("metadata.json")!.Open()).ReadToEndAsync());
            Assert.Equal(4, metadata.RootElement.GetProperty("artifact_schema_version").GetInt32());
            Assert.Null(archive.GetEntry("artifacts/best.pt"));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
