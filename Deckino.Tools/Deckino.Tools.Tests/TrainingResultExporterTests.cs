using System.IO.Compression;
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
}
