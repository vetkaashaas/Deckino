using System.IO.Compression;
using System.Text.Json;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

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

    [Theory]
    [InlineData(1, 1, false)]
    [InlineData(2, 2, false)]
    [InlineData(2, 3, false)]
    [InlineData(2, 3, true)]
    public async Task ExtractionExportIsAllowListedVersionedAndFullyVerified(int artifactSchema, int recipe, bool calibratedSelection)
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-export-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var modelVersion = $"extractor-test-v{artifactSchema}";
            var artifactRoot = paths.ArtifactRoot(modelVersion);
            Directory.CreateDirectory(artifactRoot);
            foreach (var name in new[]
                     {
                         "best.pt", "last.pt", "extractor.pt", "config.json", "preprocessing.json",
                         "thresholds.json", "evaluation.json", "grouped-metrics.json", "failures.jsonl",
                         "extraction-report.json", "workflow-state.json",
                     })
            {
                var content = name == "config.json" ? JsonSerializer.Serialize(new
                    { artifact_schema_version = artifactSchema, training_recipe_version = recipe,
                      checkpoint_selection_policy = calibratedSelection ? "calibrated-geometry-v5" : null })
                    : name == "extraction-report.json"
                    ? "{\"dataset_version\":\"corners-v1\"}"
                    : name.EndsWith(".json", StringComparison.Ordinal) ? "{}" : name;
                await File.WriteAllTextAsync(Path.Combine(artifactRoot, name), content);
            }
            await File.WriteAllTextAsync(Path.Combine(artifactRoot, "dataset-image.jpg"), "excluded");
            if (artifactSchema >= 2)
            {
                foreach (var relative in new[]
                {
                    "learning-check.json", "training-history.jsonl", "checkpoint-selection.json",
                    "dataset/manifest.jsonl", "dataset/metadata.json", "dataset/preparation-report.json",
                    "dataset/grouping-report.json", "dataset/split-assignments.json", "dataset/source-inventory.json",
                })
                {
                    var file = Path.Combine(artifactRoot, relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                    await File.WriteAllTextAsync(file, "{}");
                }
            }

            var exporter = new TrainingResultExporter(paths);
            if (recipe == 3)
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => exporter.ExportExtractionAsync(modelVersion, CancellationToken.None));
                await File.WriteAllTextAsync(Path.Combine(artifactRoot, "calibration.json"), "{\"provisional\":true}");
            }
            if (calibratedSelection)
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => exporter.ExportExtractionAsync(modelVersion, CancellationToken.None));
                await File.WriteAllTextAsync(Path.Combine(artifactRoot, "baseline-comparison.json"), "{\"status\":\"not_available\",\"reason\":\"no_baseline_checkpoint\"}");
                var gallery = Path.Combine(artifactRoot, "diagnostics", "failures");
                Directory.CreateDirectory(gallery);
                await File.WriteAllTextAsync(Path.Combine(gallery, "corners-heatmaps.png"), "diagnostic image fixture");
                await File.WriteAllTextAsync(Path.Combine(gallery, "corners-heatmaps.json"), "{\"inspection_only\":true}");
            }
            var zipPath = await exporter.ExportExtractionAsync(modelVersion, CancellationToken.None);
            var verified = await exporter.VerifyExtractionAsync(zipPath, CancellationToken.None);

            Assert.StartsWith("deckino-extraction-results-", Path.GetFileName(zipPath), StringComparison.Ordinal);
            Assert.True(verified.VerifiedEntries >= 12);
            using var archive = ZipFile.OpenRead(zipPath);
            Assert.NotNull(archive.GetEntry("artifacts/extractor.pt"));
            Assert.NotNull(archive.GetEntry("artifacts/preprocessing.json"));
            if (recipe == 3) Assert.NotNull(archive.GetEntry("artifacts/calibration.json"));
            if (calibratedSelection)
            {
                Assert.NotNull(archive.GetEntry("artifacts/baseline-comparison.json"));
                Assert.NotNull(archive.GetEntry("artifacts/diagnostics/failures/corners-heatmaps.png"));
                Assert.NotNull(archive.GetEntry("artifacts/diagnostics/failures/corners-heatmaps.json"));
            }
            Assert.Null(archive.GetEntry("artifacts/dataset-image.jpg"));
            using var metadata = JsonDocument.Parse(
                await new StreamReader(archive.GetEntry("metadata.json")!.Open()).ReadToEndAsync());
            Assert.Equal("corners-v1", metadata.RootElement.GetProperty("dataset_version").GetString());
            Assert.Equal("card-extraction", metadata.RootElement.GetProperty("artifact_kind").GetString());
            Assert.Equal(artifactSchema, metadata.RootElement.GetProperty("artifact_schema_version").GetInt32());
            if (artifactSchema >= 2)
            {
                Assert.NotNull(archive.GetEntry("artifacts/dataset/manifest.jsonl"));
                Assert.NotNull(archive.GetEntry("artifacts/checkpoint-selection.json"));
                Assert.NotNull(archive.GetEntry("artifacts/learning-check.json"));
                File.Delete(Path.Combine(artifactRoot, "dataset", "split-assignments.json"));
                await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    exporter.ExportExtractionAsync(modelVersion, CancellationToken.None));
            }
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ExtractionHandoffIsCompactAndImportsOntoAnotherWorkspace()
    {
        var sourceRoot = Path.Combine(Path.GetTempPath(), $"deckino-handoff-src-{Guid.NewGuid():N}");
        var destRoot = Path.Combine(Path.GetTempPath(), $"deckino-handoff-dst-{Guid.NewGuid():N}");
        try
        {
            var source = new TrainingPaths(sourceRoot);
            const string modelVersion = "extractor-run-20260829T155011729Z";
            await WriteHandoffArtifactAsync(source, modelVersion);
            Directory.CreateDirectory(Path.Combine(source.ArtifactRoot(modelVersion), "diagnostics"));
            await File.WriteAllTextAsync(Path.Combine(source.ArtifactRoot(modelVersion), "diagnostics", "overlay.jpg"), "preview");
            Directory.CreateDirectory(source.LogsRoot);
            await File.WriteAllTextAsync(Path.Combine(source.LogsRoot, $"run-{modelVersion}.log"), "D:\\secret\\path");

            var exporter = new TrainingResultExporter(source);
            var zipPath = await exporter.ExportExtractionHandoffAsync(modelVersion, CancellationToken.None);

            Assert.Equal(TrainingResultExporter.HandoffZipFileName(modelVersion), Path.GetFileName(zipPath));
            Assert.True(File.Exists(Path.Combine(source.HandoffRoot, TrainingResultExporter.LatestHandoffZipFileName)));
            using (var archive = ZipFile.OpenRead(zipPath))
            {
                Assert.NotNull(archive.GetEntry("artifacts/extractor.pt"));
                Assert.NotNull(archive.GetEntry("artifacts/best.pt"));
                Assert.NotNull(archive.GetEntry("artifacts/preprocessing.json"));
                Assert.NotNull(archive.GetEntry("artifacts/calibration.json"));
                Assert.Null(archive.GetEntry("artifacts/last.pt"));
                Assert.Null(archive.GetEntry("artifacts/diagnostics/overlay.jpg"));
                Assert.Null(archive.GetEntry("logs/run-extractor-run-20260829T155011729Z.log"));
                using var metadata = JsonDocument.Parse(
                    await new StreamReader(archive.GetEntry("metadata.json")!.Open()).ReadToEndAsync());
                Assert.Equal(TrainingResultExporter.ExtractionHandoffKind,
                    metadata.RootElement.GetProperty("artifact_kind").GetString());
                Assert.Equal(modelVersion, metadata.RootElement.GetProperty("model_version").GetString());
            }

            var sourcePointer = exporter.ReadCurrentExtractionPointer();
            Assert.NotNull(sourcePointer);
            Assert.Equal(modelVersion, sourcePointer.ModelVersion);
            Assert.Equal("mobilenetv3-small-card-geometry-v1", sourcePointer.Architecture);
            Assert.Equal(320, sourcePointer.InputSize);
            Assert.Equal($"training/artifacts/{modelVersion}", sourcePointer.ArtifactRoot);
            Assert.Equal("extractor.pt", sourcePointer.Files["checkpoint"]);

            var destination = new TrainingPaths(destRoot);
            var imported = await new TrainingResultExporter(destination)
                .ImportExtractionBundleAsync(zipPath, CancellationToken.None);

            Assert.Equal(modelVersion, imported.ModelVersion);
            Assert.Equal(TrainingResultExporter.ExtractionHandoffKind, imported.SourceKind);
            Assert.True(File.Exists(Path.Combine(imported.ArtifactRoot, "extractor.pt")));
            Assert.True(File.Exists(Path.Combine(imported.ArtifactRoot, "thresholds.json")));
            Assert.False(File.Exists(Path.Combine(imported.ArtifactRoot, "diagnostics", "overlay.jpg")));
            var destPointer = new TrainingResultExporter(destination).ReadCurrentExtractionPointer();
            Assert.NotNull(destPointer);
            Assert.Equal(modelVersion, destPointer.ModelVersion);
            Assert.Equal(Path.GetFileName(zipPath), destPointer.SourceZip);
        }
        finally
        {
            if (Directory.Exists(sourceRoot)) Directory.Delete(sourceRoot, recursive: true);
            if (Directory.Exists(destRoot)) Directory.Delete(destRoot, recursive: true);
        }
    }

    [Fact]
    public async Task FullExtractionResultZipCanBeImportedAsABundle()
    {
        var sourceRoot = Path.Combine(Path.GetTempPath(), $"deckino-full-src-{Guid.NewGuid():N}");
        var destRoot = Path.Combine(Path.GetTempPath(), $"deckino-full-dst-{Guid.NewGuid():N}");
        try
        {
            var source = new TrainingPaths(sourceRoot);
            const string modelVersion = "extractor-run-20260901T010203004Z";
            await WriteHandoffArtifactAsync(source, modelVersion);
            foreach (var relative in new[]
                     {
                         "last.pt", "grouped-metrics.json", "failures.jsonl", "workflow-state.json",
                         "learning-check.json", "training-history.jsonl", "checkpoint-selection.json",
                         "dataset/manifest.jsonl", "dataset/metadata.json", "dataset/preparation-report.json",
                         "dataset/grouping-report.json", "dataset/split-assignments.json",
                         "dataset/source-inventory.json", "baseline-comparison.json",
                     })
            {
                var file = Path.Combine(source.ArtifactRoot(modelVersion), relative);
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                await File.WriteAllTextAsync(file, "{}");
            }

            var zipPath = await new TrainingResultExporter(source)
                .ExportExtractionAsync(modelVersion, CancellationToken.None);
            var imported = await new TrainingResultExporter(new TrainingPaths(destRoot))
                .ImportExtractionBundleAsync(zipPath, CancellationToken.None);

            Assert.Equal(modelVersion, imported.ModelVersion);
            Assert.Equal("card-extraction", imported.SourceKind);
            Assert.True(File.Exists(Path.Combine(imported.ArtifactRoot, "extractor.pt")));
            Assert.True(File.Exists(Path.Combine(imported.ArtifactRoot, "dataset", "manifest.jsonl")));
        }
        finally
        {
            if (Directory.Exists(sourceRoot)) Directory.Delete(sourceRoot, recursive: true);
            if (Directory.Exists(destRoot)) Directory.Delete(destRoot, recursive: true);
        }
    }

    [Fact]
    public async Task HandoffPackRequiresTheServingCheckpoint()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-handoff-missing-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            const string modelVersion = "extractor-run-20260829T155011729Z";
            await WriteHandoffArtifactAsync(paths, modelVersion);
            File.Delete(Path.Combine(paths.ArtifactRoot(modelVersion), "extractor.pt"));
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                new TrainingResultExporter(paths).ExportExtractionHandoffAsync(modelVersion, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task WriteHandoffArtifactAsync(TrainingPaths paths, string modelVersion)
    {
        var artifactRoot = paths.ArtifactRoot(modelVersion);
        Directory.CreateDirectory(artifactRoot);
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "best.pt"), "best");
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "extractor.pt"), "serving");
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "config.json"), JsonSerializer.Serialize(new
        {
            artifact_schema_version = 2,
            training_recipe_version = 4,
            checkpoint_selection_policy = "geometry-guarded-v3",
            architecture = "mobilenetv3-small-card-geometry-v1",
            input_size = 320,
            model_version = modelVersion,
        }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "preprocessing.json"), "{\"input_width\":320}");
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "thresholds.json"),
            JsonSerializer.Serialize(new { model_version = modelVersion }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "evaluation.json"),
            JsonSerializer.Serialize(new { model_version = modelVersion }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "extraction-report.json"),
            JsonSerializer.Serialize(new { dataset_version = "corners-current" }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "calibration.json"), "{\"calibrated\":true}");
    }
}
