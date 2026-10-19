using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class TrainingRunSyncServiceTests
{
    [Fact]
    public async Task RunsAreListedNewestFirstAndOtherObjectsAreIgnored()
    {
        var store = new ListingStore(
            "training-runs/artwork/artwork-run-20261011T215447504Z.zip",
            "training-runs/artwork/artwork-run-20261101T080000000Z.zip",
            "training-runs/extraction/extractor-run-20261011T215255477Z.zip",
            "training-runs/extraction/notes.txt",
            "training-runs/other/run.zip");
        var runs = new TrainingRunSyncService(
            new TrainingPaths(Path.GetTempPath()), new Credentials(), store, new TrainingResultExporter(new TrainingPaths(Path.GetTempPath())),
            new WorkspaceOperationCoordinator(), () => null);

        var listed = await runs.ListAsync(CancellationToken.None);

        Assert.Equal(
            [("artwork", "artwork-run-20261101T080000000Z"), ("artwork", "artwork-run-20261011T215447504Z"),
             ("extraction", "extractor-run-20261011T215255477Z")],
            listed.Select(run => (run.Kind, run.ModelVersion)));
        Assert.Equal("training-runs/artwork/artwork-run-20261101T080000000Z.zip", listed[0].Key);
    }

    private sealed class Credentials : ISyncCredentialStore
    {
        public DatasetSyncCredentials? Load() => new("https://storage.example", "bucket", "auto", true, "key", "secret");
        public void Save(DatasetSyncCredentials credentials) { }
        public void Clear() { }
    }

    private sealed class ListingStore(params string[] keys) : IRemoteObjectStoreFactory, IRemoteObjectStore
    {
        public IRemoteObjectStore Create(DatasetSyncCredentials credentials) => this;
        public Task ProbeAsync(string prefix, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<IReadOnlyList<RemoteDatasetObject>> ListAsync(string prefix, Func<string, string?, long, string?>? knownSha256,
            Action<int, int>? reportProgress, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<RemoteDatasetObject>>(
                keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)).Select(key => new RemoteDatasetObject(key, null, null, 10)).ToList());
        public Task DownloadAsync(string key, string destinationPath, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task UploadAsync(string key, string sourcePath, string sha256, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task UploadBytesAsync(string key, ReadOnlyMemory<byte> content, string sha256, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task DeleteAsync(string key, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
