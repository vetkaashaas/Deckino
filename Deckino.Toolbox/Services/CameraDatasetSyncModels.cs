namespace Deckino.Toolbox.Services;

public sealed record DatasetSyncCredentials(
    string Endpoint,
    string Bucket,
    string Region,
    bool ForcePathStyle,
    string AccessKeyId,
    string SecretAccessKey)
{
    public bool IsComplete => Uri.TryCreate(Endpoint, UriKind.Absolute, out _)
        && !string.IsNullOrWhiteSpace(Bucket)
        && !string.IsNullOrWhiteSpace(Region)
        && !string.IsNullOrWhiteSpace(AccessKeyId)
        && !string.IsNullOrWhiteSpace(SecretAccessKey);
}

public sealed record RemoteDatasetObject(
    string Key,
    string? Sha256,
    string? ETag,
    long Size);

public sealed record DatasetSyncConflict(
    string ObjectKey,
    string RelativePath,
    string RemoteCopyPath,
    string LocalSha256,
    string RemoteSha256,
    DateTimeOffset CreatedUtc);

public sealed record DatasetSyncSnapshot(
    bool IsConfigured,
    bool IsRunning,
    int LocalFiles,
    int RemoteFiles,
    int PendingUploads,
    int FailedOperations,
    int ConflictCount,
    DateTimeOffset? LastSuccessfulSyncUtc,
    string Status)
{
    public bool SafeToSwitch => IsConfigured && !IsRunning
        && PendingUploads == 0 && FailedOperations == 0 && ConflictCount == 0;
}

public sealed record DatasetSyncResult(
    int Uploaded,
    int Downloaded,
    int Deleted,
    int Conflicts,
    IReadOnlyList<string> Errors);

public interface ISyncCredentialStore
{
    DatasetSyncCredentials? Load();
    void Save(DatasetSyncCredentials credentials);
    void Clear();
}

public interface IRemoteObjectStore : IAsyncDisposable
{
    Task ProbeAsync(string prefix, CancellationToken cancellationToken);
    // knownSha256(key, etag, size) returns a cached hash for an unchanged object, which then needs no metadata request.
    Task<IReadOnlyList<RemoteDatasetObject>> ListAsync(
        string prefix,
        Func<string, string?, long, string?>? knownSha256,
        Action<int, int>? reportProgress,
        CancellationToken cancellationToken);
    Task DownloadAsync(string key, string destinationPath, CancellationToken cancellationToken);
    // reportPercent gets 0–100 while the object downloads; stores that cannot tell only report the end.
    async Task DownloadAsync(
        string key, string destinationPath, Action<int> reportPercent, CancellationToken cancellationToken)
    {
        await DownloadAsync(key, destinationPath, cancellationToken);
        reportPercent(100);
    }
    Task UploadAsync(string key, string sourcePath, string sha256, CancellationToken cancellationToken);
    // reportBytes gets the bytes sent so far while the file uploads; stores that cannot tell only report the end.
    async Task UploadAsync(
        string key, string sourcePath, string sha256, Action<long> reportBytes, CancellationToken cancellationToken)
    {
        await UploadAsync(key, sourcePath, sha256, cancellationToken);
        reportBytes(new FileInfo(sourcePath).Length);
    }
    Task UploadBytesAsync(string key, ReadOnlyMemory<byte> content, string sha256, CancellationToken cancellationToken);
    Task DeleteAsync(string key, CancellationToken cancellationToken);
}

public interface IRemoteObjectStoreFactory
{
    IRemoteObjectStore Create(DatasetSyncCredentials credentials);
}

public interface ICameraDatasetChangeTracker
{
    void TrackUpload(string path);
    // Many files at once: one queue write and one local recount instead of one per file.
    void TrackUploads(IReadOnlyList<string> paths);
    void TrackTree(string root);
    void TrackDeletion(string path);
}

public interface ICameraDatasetSyncService : ICameraDatasetChangeTracker, IAsyncDisposable
{
    event EventHandler? StateChanged;
    DatasetSyncCredentials? LoadCredentials();
    void SaveCredentials(DatasetSyncCredentials credentials);
    DatasetSyncSnapshot GetSnapshot();
    IReadOnlyList<DatasetSyncConflict> GetConflicts();
    Task TestConnectionAsync(DatasetSyncCredentials credentials, CancellationToken cancellationToken);
    Task<DatasetSyncResult> SyncNowAsync(CancellationToken cancellationToken);
    Task KeepLocalAsync(string objectKey, CancellationToken cancellationToken);
    Task KeepRemoteAsync(string objectKey, CancellationToken cancellationToken);
    Task ProcessPendingAsync(CancellationToken cancellationToken);
}
