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
    Task<IReadOnlyList<RemoteDatasetObject>> ListAsync(
        string prefix,
        Action<int, int>? reportProgress,
        CancellationToken cancellationToken);
    Task DownloadAsync(string key, string destinationPath, CancellationToken cancellationToken);
    Task UploadAsync(string key, string sourcePath, string sha256, CancellationToken cancellationToken);
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
