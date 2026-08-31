using System.Collections.Concurrent;
using System.Security.Cryptography;
using Amazon.S3.Model;
using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class CameraDatasetSyncTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "deckino-sync-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void ObjectKeysAreStableAndTombstonesDoNotExposePaths()
    {
        var key = CameraDatasetSyncService.ObjectKey(Path.Combine("batch", "nested", "photo.jpg"));
        var tombstone = CameraDatasetSyncService.TombstoneKey(key);

        Assert.Equal("camera/v1/files/batch/nested/photo.jpg", key);
        Assert.StartsWith("camera/v1/tombstones/", tombstone, StringComparison.Ordinal);
        Assert.EndsWith(".json", tombstone, StringComparison.Ordinal);
        Assert.DoesNotContain("photo.jpg", tombstone, StringComparison.Ordinal);
    }

    [Fact]
    public void EmptyS3ListResponseIsTreatedAsAnEmptyBucket()
    {
        var response = new ListObjectsV2Response { S3Objects = null };

        Assert.Empty(RailwayS3ObjectStore.ObjectsOrEmpty(response));
        Assert.Empty(RailwayS3ObjectStore.ObjectsOrEmpty(null));
    }

    [Fact]
    public void CredentialsRoundTripThroughDpapiWithoutPlaintextOnDisk()
    {
        var path = Path.Combine(_root, "credentials", "dataset-sync.credentials");
        var store = new DpapiSyncCredentialStore(path);

        store.Save(TestCredentials);

        Assert.Equal(TestCredentials, store.Load());
        var encryptedText = Convert.ToBase64String(File.ReadAllBytes(path));
        Assert.DoesNotContain(TestCredentials.SecretAccessKey, encryptedText, StringComparison.Ordinal);
        Assert.DoesNotContain(TestCredentials.AccessKeyId, encryptedText, StringComparison.Ordinal);
    }

    [Fact]
    public void CompletedTransferCannotEraseANewerOperationForTheSameObject()
    {
        var catalog = new CameraDatasetSyncCatalog(Path.Combine(_root, "catalog-race", "sync.db"));
        const string key = "camera/v1/files/batch/photo.jpg";
        catalog.Queue(key, "batch\\photo.jpg", DatasetSyncOperation.Upload, null);
        var inFlightUpload = Assert.Single(catalog.Pending(includeDeferred: true));

        catalog.Queue(key, "batch\\photo.jpg", DatasetSyncOperation.Delete, null);

        Assert.False(catalog.Complete(inFlightUpload, "old-upload-sha"));
        var remaining = Assert.Single(catalog.Pending(includeDeferred: true));
        Assert.Equal(DatasetSyncOperation.Delete, remaining.Operation);
    }

    [Fact]
    public async Task RemoteFilesDownloadOnlyDuringManualSync()
    {
        var remote = new FakeRemoteBucket();
        remote.Seed("camera/v1/files/batch/photo.jpg", [1, 2, 3, 4]);
        var paths = new TrainingPaths(Path.Combine(_root, "manual-download"));
        await using var service = CreateService(paths, remote);
        var localPath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.jpg");

        await Task.Delay(400);
        Assert.False(File.Exists(localPath));

        var result = await service.SyncNowAsync(CancellationToken.None);

        Assert.Equal(1, result.Downloaded);
        Assert.Equal([1, 2, 3, 4], File.ReadAllBytes(localPath));
    }

    [Fact]
    public async Task FirstSyncUploadsExistingLocalDataset()
    {
        var remote = new FakeRemoteBucket();
        var paths = new TrainingPaths(Path.Combine(_root, "seed-local"));
        var localPath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(localPath)!);
        await File.WriteAllBytesAsync(localPath, [7, 8, 9]);
        await using var service = CreateService(paths, remote);

        var result = await service.SyncNowAsync(CancellationToken.None);

        Assert.Equal(1, result.Uploaded);
        Assert.Equal([7, 8, 9], remote.Read("camera/v1/files/batch/photo.jpg"));
        Assert.True(service.GetSnapshot().SafeToSwitch);
    }

    [Fact]
    public async Task UploadProgressPublishesChangingPendingAndRemoteCounts()
    {
        var remote = new FakeRemoteBucket { OperationDelay = TimeSpan.FromMilliseconds(125) };
        var paths = new TrainingPaths(Path.Combine(_root, "live-progress"));
        var batch = Path.Combine(paths.CameraImportsRoot, "batch");
        Directory.CreateDirectory(batch);
        for (var index = 0; index < 20; index++)
            await File.WriteAllBytesAsync(Path.Combine(batch, $"photo-{index:00}.jpg"), [(byte)index]);
        await using var service = CreateService(paths, remote);
        var snapshots = new ConcurrentQueue<DatasetSyncSnapshot>();
        service.StateChanged += (_, _) => snapshots.Enqueue(service.GetSnapshot());

        await service.SyncNowAsync(CancellationToken.None);

        Assert.Contains(snapshots, snapshot => snapshot.PendingUploads is > 0 and < 20
            && snapshot.RemoteFiles is > 0 and < 20);
        Assert.Equal(20, service.GetSnapshot().RemoteFiles);
    }

    [Fact]
    public async Task OutboxUsesBoundedParallelTransfers()
    {
        var remote = new FakeRemoteBucket { OperationDelay = TimeSpan.FromMilliseconds(75) };
        var paths = new TrainingPaths(Path.Combine(_root, "parallel-uploads"));
        var batch = Path.Combine(paths.CameraImportsRoot, "batch");
        Directory.CreateDirectory(batch);
        for (var index = 0; index < 20; index++)
            await File.WriteAllBytesAsync(Path.Combine(batch, $"photo-{index:00}.jpg"), [(byte)index]);
        await using var service = CreateService(paths, remote);

        await service.SyncNowAsync(CancellationToken.None);

        Assert.True(remote.MaximumConcurrentOperations > 1);
        Assert.True(remote.MaximumConcurrentOperations <= CameraDatasetSyncService.MaximumParallelTransfers);
        Assert.Equal(20, service.GetSnapshot().RemoteFiles);
    }

    [Fact]
    public async Task DifferingFirstSyncCopiesArePreservedAsConflict()
    {
        var remote = new FakeRemoteBucket();
        remote.Seed("camera/v1/files/batch/photo.jpg", [4, 5, 6]);
        var paths = new TrainingPaths(Path.Combine(_root, "conflict"));
        var localPath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(localPath)!);
        await File.WriteAllBytesAsync(localPath, [1, 2, 3]);
        await using var service = CreateService(paths, remote);

        var result = await service.SyncNowAsync(CancellationToken.None);

        Assert.Equal(1, result.Conflicts);
        var conflict = Assert.Single(service.GetConflicts());
        Assert.Equal([1, 2, 3], File.ReadAllBytes(localPath));
        Assert.Equal([4, 5, 6], File.ReadAllBytes(conflict.RemoteCopyPath));

        await service.KeepRemoteAsync(conflict.ObjectKey, CancellationToken.None);
        Assert.Equal([4, 5, 6], File.ReadAllBytes(localPath));
        Assert.Empty(service.GetConflicts());
    }

    [Fact]
    public async Task PermanentTombstoneDeletesStaleCopyOnAnotherComputer()
    {
        var remote = new FakeRemoteBucket();
        var firstPaths = new TrainingPaths(Path.Combine(_root, "delete-first"));
        var firstPath = Path.Combine(firstPaths.CameraImportsRoot, "batch", "photo.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(firstPath)!);
        await File.WriteAllBytesAsync(firstPath, [9, 9, 9]);
        await using (var first = CreateService(firstPaths, remote))
        {
            await first.SyncNowAsync(CancellationToken.None);
            File.Delete(firstPath);
            first.TrackDeletion(firstPath);
            await first.ProcessPendingAsync(CancellationToken.None);
            Assert.DoesNotContain("camera/v1/files/batch/photo.jpg", remote.Keys);
            Assert.Contains(remote.Keys, key => key.StartsWith("camera/v1/tombstones/", StringComparison.Ordinal));
        }

        var secondPaths = new TrainingPaths(Path.Combine(_root, "delete-second"));
        var stalePath = Path.Combine(secondPaths.CameraImportsRoot, "batch", "photo.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(stalePath)!);
        await File.WriteAllBytesAsync(stalePath, [9, 9, 9]);
        await using var second = CreateService(secondPaths, remote);

        var result = await second.SyncNowAsync(CancellationToken.None);

        Assert.Equal(1, result.Deleted);
        Assert.False(File.Exists(stalePath));
    }

    [Fact]
    public async Task AnnotationSaveQueuesAutomaticUploadWithoutWaitingForManualDownload()
    {
        var remote = new FakeRemoteBucket();
        var paths = new TrainingPaths(Path.Combine(_root, "annotation-upload"));
        await using var service = CreateService(paths, remote);
        var store = new CameraAnnotationStore(paths, service);
        var imagePath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(imagePath)!);
        await File.WriteAllBytesAsync(imagePath, [1, 2, 3]);

        store.SaveNew(imagePath, new CardAnnotation
        {
            ImageFile = "photo.jpg",
            TopLeft = new(.1, .1),
            TopRight = new(.9, .1),
            BottomRight = new(.9, .9),
            BottomLeft = new(.1, .9),
            ImageWidth = 100,
            ImageHeight = 140,
            SourceGroup = "batch/source",
        });
        await service.ProcessPendingAsync(CancellationToken.None);

        Assert.Contains("camera/v1/files/batch/photo._annotations.json", remote.Keys);
        Assert.Equal(0, service.GetSnapshot().PendingUploads);
    }

    [Fact]
    public async Task InvalidRemoteAnnotationIsNotAppliedLocally()
    {
        var remote = new FakeRemoteBucket();
        remote.Seed("camera/v1/files/batch/photo._annotations.json", "{}"u8.ToArray());
        var paths = new TrainingPaths(Path.Combine(_root, "invalid-annotation"));
        await using var service = CreateService(paths, remote);

        var result = await service.SyncNowAsync(CancellationToken.None);

        Assert.Single(result.Errors);
        Assert.False(File.Exists(Path.Combine(paths.CameraImportsRoot, "batch", "photo._annotations.json")));
    }

    private static CameraDatasetSyncService CreateService(TrainingPaths paths, FakeRemoteBucket remote) =>
        new(paths, new InMemoryCredentialStore(TestCredentials), new FakeRemoteFactory(remote));

    private static DatasetSyncCredentials TestCredentials { get; } =
        new("https://storage.example.test", "deckino", "auto", false, "access", "secret");

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class InMemoryCredentialStore(DatasetSyncCredentials credentials) : ISyncCredentialStore
    {
        private DatasetSyncCredentials? _credentials = credentials;
        public DatasetSyncCredentials? Load() => _credentials;
        public void Save(DatasetSyncCredentials value) => _credentials = value;
        public void Clear() => _credentials = null;
    }

    private sealed class FakeRemoteFactory(FakeRemoteBucket bucket) : IRemoteObjectStoreFactory
    {
        public IRemoteObjectStore Create(DatasetSyncCredentials credentials) => new FakeRemoteObjectStore(bucket);
    }

    private sealed class FakeRemoteBucket
    {
        private readonly ConcurrentDictionary<string, StoredObject> _objects = new(StringComparer.Ordinal);
        private int _activeOperations;
        private int _maximumConcurrentOperations;
        public TimeSpan OperationDelay { get; init; }
        public int MaximumConcurrentOperations => Volatile.Read(ref _maximumConcurrentOperations);
        public IReadOnlyCollection<string> Keys => _objects.Keys.ToArray();

        public void Seed(string key, byte[] content) => _objects[key] = StoredObject.From(content);
        public byte[] Read(string key) => _objects[key].Content.ToArray();
        public IReadOnlyList<RemoteDatasetObject> List(string prefix) => _objects
            .Where(item => item.Key.StartsWith(prefix, StringComparison.Ordinal))
            .Select(item => new RemoteDatasetObject(item.Key, item.Value.Sha256, item.Value.Sha256, item.Value.Content.Length))
            .OrderBy(item => item.Key, StringComparer.Ordinal)
            .ToArray();
        public void Put(string key, byte[] content) => _objects[key] = StoredObject.From(content);
        public bool Delete(string key) => _objects.TryRemove(key, out _);

        public async Task DelayOperationAsync(CancellationToken cancellationToken)
        {
            if (OperationDelay <= TimeSpan.Zero) return;
            var active = Interlocked.Increment(ref _activeOperations);
            while (true)
            {
                var maximum = Volatile.Read(ref _maximumConcurrentOperations);
                if (active <= maximum
                    || Interlocked.CompareExchange(ref _maximumConcurrentOperations, active, maximum) == maximum)
                    break;
            }
            try
            {
                await Task.Delay(OperationDelay, cancellationToken);
            }
            finally
            {
                Interlocked.Decrement(ref _activeOperations);
            }
        }

        private sealed record StoredObject(byte[] Content, string Sha256)
        {
            public static StoredObject From(byte[] content) => new(
                content.ToArray(), Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant());
        }
    }

    private sealed class FakeRemoteObjectStore(FakeRemoteBucket bucket) : IRemoteObjectStore
    {
        public Task<IReadOnlyList<RemoteDatasetObject>> ListAsync(string prefix, CancellationToken cancellationToken) =>
            Task.FromResult(bucket.List(prefix));

        public Task DownloadAsync(string key, string destinationPath, CancellationToken cancellationToken)
        {
            File.WriteAllBytes(destinationPath, bucket.Read(key));
            return Task.CompletedTask;
        }

        public async Task UploadAsync(string key, string sourcePath, string sha256, CancellationToken cancellationToken)
        {
            await bucket.DelayOperationAsync(cancellationToken);
            bucket.Put(key, File.ReadAllBytes(sourcePath));
        }

        public async Task UploadBytesAsync(string key, ReadOnlyMemory<byte> content, string sha256, CancellationToken cancellationToken)
        {
            await bucket.DelayOperationAsync(cancellationToken);
            bucket.Put(key, content.ToArray());
        }

        public Task DeleteAsync(string key, CancellationToken cancellationToken)
        {
            bucket.Delete(key);
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
