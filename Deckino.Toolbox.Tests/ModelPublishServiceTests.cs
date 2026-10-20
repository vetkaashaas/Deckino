using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class ModelPublishServiceTests : IDisposable
{
    private const string Version = "extractor-run-20261011T215255477Z";
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"deckino-model-publish-{Guid.NewGuid():N}");
    private readonly RecordingStores _stores = new();

    [Fact]
    public async Task VerifiedExportUploadsTheFilesThenThePointer()
    {
        var publisher = Arrange(passed: true);

        var published = await publisher.PublishAsync("extractor", _ => { }, CancellationToken.None);

        Assert.Equal(Version, published.ModelVersion);
        Assert.Equal(1, published.Schema);
        Assert.Equal(
            [$"models/extractor/{Version}/extractor.onnx", $"models/extractor/{Version}/refiner.onnx",
             $"models/extractor/{Version}/mobile-manifest.json", $"models/extractor/{Version}/thresholds.json",
             "models/extractor/schema-1/latest.json"],
            _stores.Keys);
        var pointer = JsonNode.Parse(_stores.Pointer!)!;
        Assert.Equal(Version, pointer["modelVersion"]!.GetValue<string>());
        // The app checks each download against its MD5 (lowercase hex, as expo-file-system reports it).
        Assert.Equal(Convert.ToHexString(MD5.HashData("extractor.onnx"u8)).ToLowerInvariant(),
            pointer["files"]![0]!["md5"]!.GetValue<string>());
    }

    [Fact]
    public async Task UnverifiedExportIsRefusedBeforeAnythingUploads()
    {
        var publisher = Arrange(passed: false);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => publisher.PublishAsync("extractor", _ => { }, CancellationToken.None));

        Assert.Contains("ensure-extraction-mobile.ps1", error.Message);
        Assert.Empty(_stores.Keys);
    }

    private ModelPublishService Arrange(bool passed)
    {
        var paths = new TrainingPaths(_root);
        var folder = Path.Combine(paths.TrainingRoot, "mobile", "extractor", Version);
        Directory.CreateDirectory(folder);
        File.WriteAllText(paths.CurrentExtractionPointerPath, JsonSerializer.Serialize(new { model_version = Version }));
        File.WriteAllText(Path.Combine(folder, "app-verification.json"), JsonSerializer.Serialize(new { model_version = Version, passed }));
        File.WriteAllText(Path.Combine(folder, "mobile-manifest.json"),
            JsonSerializer.Serialize(new { model_version = Version, mobile_export_schema_version = 1 }));
        foreach (var name in new[] { "extractor.onnx", "refiner.onnx", "thresholds.json" })
            File.WriteAllText(Path.Combine(folder, name), name);
        // No repository scripts: the phone files can't be made here, so an unchecked model is refused.
        return new ModelPublishService(paths, new Credentials(), _stores, new PythonProcessRunner(paths), scriptsRoot: null);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class Credentials : ISyncCredentialStore
    {
        public DatasetSyncCredentials? Load() => new("https://storage.example", "bucket", "auto", true, "key", "secret");
        public void Save(DatasetSyncCredentials credentials) { }
        public void Clear() { }
    }

    private sealed class RecordingStores : IRemoteObjectStoreFactory, IRemoteObjectStore
    {
        public List<string> Keys { get; } = [];
        public byte[]? Pointer { get; private set; }

        public IRemoteObjectStore Create(DatasetSyncCredentials credentials) => this;
        public Task ProbeAsync(string prefix, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<IReadOnlyList<RemoteDatasetObject>> ListAsync(string prefix, Func<string, string?, long, string?>? knownSha256,
            Action<int, int>? reportProgress, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task DownloadAsync(string key, string destinationPath, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task DeleteAsync(string key, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        public Task UploadAsync(string key, string sourcePath, string sha256, CancellationToken cancellationToken)
        {
            Keys.Add(key);
            return Task.CompletedTask;
        }

        public Task UploadBytesAsync(string key, ReadOnlyMemory<byte> content, string sha256, CancellationToken cancellationToken)
        {
            Keys.Add(key);
            Pointer = content.ToArray();
            return Task.CompletedTask;
        }
    }
}
