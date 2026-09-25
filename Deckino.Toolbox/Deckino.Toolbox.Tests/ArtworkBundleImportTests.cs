using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class ArtworkBundleImportTests : IDisposable
{
    private const string ModelVersion = "mobilenetv3s-512-art-v4";
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"deckino-artwork-import-{Guid.NewGuid():N}");

    [Fact]
    public async Task LaptopExportImportsOnAnotherPcWithPointer()
    {
        var zipPath = await ExportFromLaptopAsync(prototypes: 6);
        var desktop = new TrainingPaths(Path.Combine(_root, "desktop"));
        var exporter = new TrainingResultExporter(desktop);

        var imported = await exporter.ImportArtworkIdentityBundleAsync(zipPath, CancellationToken.None);

        Assert.Equal(ModelVersion, imported.ModelVersion);
        Assert.Equal(6, imported.Prototypes);
        Assert.Equal(4, imported.EmbeddingDimension);
        Assert.Equal("paper-art-v4", imported.DatasetVersion);
        Assert.True(imported.Qualified);
        Assert.Null(imported.ReplacedPath);
        Assert.True(File.Exists(Path.Combine(desktop.ArtifactRoot(ModelVersion), "embedding.pt")));
        Assert.True(File.Exists(Path.Combine(desktop.ArtifactRoot(ModelVersion), "index", "index.f32")));
        var pointer = exporter.ReadCurrentArtworkPointer();
        Assert.NotNull(pointer);
        Assert.Equal(ModelVersion, pointer.ModelVersion);
        Assert.Equal(6, pointer.Prototypes);
        // Staging folders never survive a completed import.
        Assert.DoesNotContain(Directory.EnumerateDirectories(desktop.ArtifactsRoot), path => Path.GetFileName(path).StartsWith('.'));
    }

    [Fact]
    public async Task ReimportKeepsThePreviousModelAsABackup()
    {
        var zipPath = await ExportFromLaptopAsync(prototypes: 6);
        var desktop = new TrainingPaths(Path.Combine(_root, "desktop"));
        var exporter = new TrainingResultExporter(desktop);
        await exporter.ImportArtworkIdentityBundleAsync(zipPath, CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(desktop.ArtifactRoot(ModelVersion), "local-note.txt"), "keep me");

        var second = await exporter.ImportArtworkIdentityBundleAsync(zipPath, CancellationToken.None);

        Assert.NotNull(second.ReplacedPath);
        Assert.True(File.Exists(Path.Combine(second.ReplacedPath, "local-note.txt")));
        Assert.False(File.Exists(Path.Combine(desktop.ArtifactRoot(ModelVersion), "local-note.txt")));
    }

    [Fact]
    public async Task IndexThatDoesNotMatchItsChecksumIsRejectedAndNothingIsReplaced()
    {
        var zipPath = await ExportFromLaptopAsync(prototypes: 6, corruptVectorChecksum: true);
        var desktop = new TrainingPaths(Path.Combine(_root, "desktop"));
        var existing = desktop.ArtifactRoot(ModelVersion);
        Directory.CreateDirectory(existing);
        await File.WriteAllTextAsync(Path.Combine(existing, "embedding.pt"), "previous model");

        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            new TrainingResultExporter(desktop).ImportArtworkIdentityBundleAsync(zipPath, CancellationToken.None));

        Assert.Contains("checksum", error.Message);
        Assert.Equal("previous model", await File.ReadAllTextAsync(Path.Combine(existing, "embedding.pt")));
        Assert.False(File.Exists(desktop.CurrentArtworkPointerPath));
        Assert.DoesNotContain(Directory.EnumerateDirectories(desktop.ArtifactsRoot), path => Path.GetFileName(path).StartsWith('.'));
    }

    [Fact]
    public async Task ExtractionBundlesAreNotImportedAsArtwork()
    {
        var laptop = new TrainingPaths(Path.Combine(_root, "laptop"));
        var artifact = laptop.ArtifactRoot("extractor-run-20260101T000000000Z");
        Directory.CreateDirectory(artifact);
        foreach (var name in new[] { "best.pt", "extractor.pt", "config.json", "preprocessing.json", "thresholds.json",
                     "evaluation.json", "extraction-report.json" })
            await File.WriteAllTextAsync(Path.Combine(artifact, name), name.EndsWith(".json") ? "{}" : name);
        var zipPath = await new TrainingResultExporter(laptop)
            .ExportExtractionHandoffAsync("extractor-run-20260101T000000000Z", CancellationToken.None);

        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            new TrainingResultExporter(new TrainingPaths(Path.Combine(_root, "desktop")))
                .ImportArtworkIdentityBundleAsync(zipPath, CancellationToken.None));
        Assert.Contains("not an artwork identity bundle", error.Message);
    }

    private async Task<string> ExportFromLaptopAsync(int prototypes, bool corruptVectorChecksum = false)
    {
        var laptop = new TrainingPaths(Path.Combine(_root, "laptop"));
        var artifactRoot = laptop.ArtifactRoot(ModelVersion);
        var indexRoot = Path.Combine(artifactRoot, "index");
        Directory.CreateDirectory(indexRoot);
        const int dimension = 4;
        var vectors = new byte[prototypes * dimension * sizeof(float)];
        for (var index = 0; index < prototypes * dimension; index++)
            BitConverter.GetBytes(index % dimension == index / dimension % dimension ? 1f : 0f).CopyTo(vectors, index * 4);
        await File.WriteAllBytesAsync(Path.Combine(indexRoot, "index.f32"), vectors);
        var checksum = Convert.ToHexString(SHA256.HashData(vectors)).ToLowerInvariant();
        var metadata = new Dictionary<string, object>
        {
            ["index_schema_version"] = 1, ["artifact_schema_version"] = 4, ["dataset_version"] = "paper-art-v4",
            ["checkpoint_model_version"] = ModelVersion, ["count"] = prototypes, ["embedding_dimension"] = dimension,
            ["dtype"] = "float32", ["normalization"] = "l2",
            ["vectors_sha256"] = corruptVectorChecksum ? new string('0', 64) : checksum, ["labels_sha256"] = "unused",
        };
        await File.WriteAllTextAsync(Path.Combine(indexRoot, "index-metadata.json"), JsonSerializer.Serialize(metadata));
        await File.WriteAllTextAsync(Path.Combine(indexRoot, "index-labels.json"),
            JsonSerializer.Serialize(new { labels = Array.Empty<object>() }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "artwork-thresholds.json"), JsonSerializer.Serialize(new
        {
            artifact_schema_version = 4, dataset_version = "paper-art-v4", checkpoint_model_version = ModelVersion,
            score_threshold = 0.6, margin_threshold = 0.05,
        }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "identity-report.json"),
            JsonSerializer.Serialize(new { dataset_version = "paper-art-v4", baseline_qualified = true, camera_qualified = (bool?)null }));
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "retrieval-report.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(artifactRoot, "retrieval-failures.jsonl"), "");
        await File.WriteAllBytesAsync(Path.Combine(artifactRoot, "embedding.pt"), [1, 2, 3, 4]);
        return await new TrainingResultExporter(laptop).ExportArtworkIdentityAsync(ModelVersion, CancellationToken.None);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
