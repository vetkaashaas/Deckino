using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.IO;

namespace Deckino.Toolbox.Services;

public sealed class CameraDatasetSyncService : ICameraDatasetSyncService
{
    internal const string FilesPrefix = "camera/v1/files/";
    internal const string TombstonesPrefix = "camera/v1/tombstones/";
    internal const int MaximumParallelTransfers = 8;
    internal static readonly TimeSpan ConnectionTestTimeout = TimeSpan.FromSeconds(15);

    private static readonly HashSet<string> ImageExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png" };

    private readonly TrainingPaths _paths;
    private readonly ISyncCredentialStore _credentialStore;
    private readonly IRemoteObjectStoreFactory _remoteFactory;
    private readonly CameraDatasetSyncCatalog _catalog;
    private readonly SemaphoreSlim _remoteGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly object _inventoryGate = new();
    private DatasetSyncCredentials? _credentials;
    private Task? _workerTask;
    private int _workerScheduled;
    private bool _isRunning;
    private int _localFiles;
    private int _remoteFiles;
    private HashSet<string> _knownRemoteKeys = [];
    private long _lastProgressNotificationTicks;
    private string _status = "Dataset sync is not configured.";

    public event EventHandler? StateChanged;

    public CameraDatasetSyncService(
        TrainingPaths paths,
        ISyncCredentialStore credentialStore,
        IRemoteObjectStoreFactory remoteFactory)
    {
        _paths = paths;
        _credentialStore = credentialStore;
        _remoteFactory = remoteFactory;
        _catalog = new CameraDatasetSyncCatalog(Path.Combine(paths.CameraRoot, "dataset-sync.db"));
        _credentials = _credentialStore.Load();
        _localFiles = EnumerateLocalFiles().Count;
        _knownRemoteKeys = _catalog.SynchronizedObjectKeys().ToHashSet(StringComparer.Ordinal);
        _remoteFiles = _knownRemoteKeys.Count;
        if (LoadCredentials() is not null)
        {
            _status = "Ready. Remote downloads run only when you choose Sync now.";
            ScheduleWorker();
        }
    }

    public DatasetSyncCredentials? LoadCredentials() => _credentials;

    public void SaveCredentials(DatasetSyncCredentials credentials)
    {
        _credentialStore.Save(credentials);
        _credentials = credentials;
        _status = "Connection saved. Choose Sync now to merge this computer with the bucket.";
        RaiseStateChanged();
        ScheduleWorker();
    }

    public DatasetSyncSnapshot GetSnapshot()
    {
        var counts = _catalog.Counts();
        return new DatasetSyncSnapshot(
            LoadCredentials() is not null,
            _isRunning,
            _localFiles,
            _remoteFiles,
            counts.Pending,
            counts.Failed,
            _catalog.Conflicts().Count,
            _catalog.LastSuccessfulSyncUtc,
            _status);
    }

    public IReadOnlyList<DatasetSyncConflict> GetConflicts() => _catalog.Conflicts();

    public async Task TestConnectionAsync(DatasetSyncCredentials credentials, CancellationToken cancellationToken)
    {
        await using var remote = _remoteFactory.Create(credentials);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ConnectionTestTimeout);
        try
        {
            await remote.ProbeAsync("camera/v1/", timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && timeout.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"The Railway bucket did not respond within {ConnectionTestTimeout.TotalSeconds:0} seconds. " +
                "Check the endpoint and URL style against the bucket Credentials tab.");
        }
    }

    public void TrackUpload(string path)
    {
        if (LoadCredentials() is null || !File.Exists(path) || !IsDatasetFile(path)) return;
        try
        {
            var relative = RelativePath(path);
            _catalog.Queue(ObjectKey(relative), relative, DatasetSyncOperation.Upload, null);
            _localFiles = EnumerateLocalFiles().Count;
            _status = "Local changes are waiting to upload.";
            RaiseStateChanged();
            ScheduleWorker();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            _status = $"Could not queue a dataset upload: {error.Message}";
            RaiseStateChanged();
        }
    }

    public void TrackTree(string root)
    {
        if (LoadCredentials() is null || !Directory.Exists(root)) return;
        try
        {
            var operations = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Where(IsDatasetFile)
                .Select(path =>
                {
                    var relative = RelativePath(path);
                    return (ObjectKey(relative), relative, DatasetSyncOperation.Upload, (string?)null);
                })
                .ToArray();
            _catalog.QueueMany(operations);
            _localFiles = EnumerateLocalFiles().Count;
            _status = "Imported dataset files are waiting to upload.";
            RaiseStateChanged();
            ScheduleWorker();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            _status = $"Could not queue the imported dataset: {error.Message}";
            RaiseStateChanged();
        }
    }

    public void TrackDeletion(string path)
    {
        if (LoadCredentials() is null) return;
        try
        {
            var relative = RelativePath(path);
            _catalog.Queue(ObjectKey(relative), relative, DatasetSyncOperation.Delete, null);
            _localFiles = EnumerateLocalFiles().Count;
            _status = "Local deletions are waiting to synchronize.";
            RaiseStateChanged();
            ScheduleWorker();
        }
        catch (InvalidOperationException error)
        {
            _status = $"Could not queue a dataset deletion: {error.Message}";
            RaiseStateChanged();
        }
    }

    public async Task ProcessPendingAsync(CancellationToken cancellationToken)
    {
        var credentials = LoadCredentials();
        if (credentials is null) return;
        await _remoteGate.WaitAsync(cancellationToken);
        try
        {
            SetRunning(true, "Uploading pending local dataset changes…");
            await using var remote = _remoteFactory.Create(credentials);
            await ProcessPendingCoreAsync(remote, includeDeferred: false, cancellationToken);
            var counts = _catalog.Counts();
            _status = counts.Pending == 0
                ? "All local changes are uploaded. Remote downloads run only with Sync now."
                : $"{counts.Pending:N0} dataset operations are waiting to retry.";
        }
        finally
        {
            SetRunning(false, _status);
            _remoteGate.Release();
        }
    }

    public async Task<DatasetSyncResult> SyncNowAsync(CancellationToken cancellationToken)
    {
        var credentials = LoadCredentials()
            ?? throw new InvalidOperationException("Save the Railway bucket connection before synchronizing.");
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        var syncCancellationToken = linkedCancellation.Token;
        await _remoteGate.WaitAsync(syncCancellationToken);
        try
        {
            SetRunning(true, "Synchronizing the camera dataset…");
            _localFiles = EnumerateLocalFiles().Count;
            await using var remote = _remoteFactory.Create(credentials);
            var uploaded = await ProcessPendingCoreAsync(remote, includeDeferred: true, syncCancellationToken);
            var errors = new List<string>();
            var downloaded = 0;
            var deleted = 0;
            var conflicts = 0;

            SetRunning(true, "Reading the remote dataset inventory…");
            var remoteObjects = await remote.ListAsync(
                "camera/v1/",
                ReportInventoryProgress,
                syncCancellationToken);
            var remoteFiles = remoteObjects
                .Where(item => item.Key.StartsWith(FilesPrefix, StringComparison.Ordinal))
                .ToDictionary(item => item.Key, StringComparer.Ordinal);
            lock (_inventoryGate)
            {
                _knownRemoteKeys = remoteFiles.Keys.ToHashSet(StringComparer.Ordinal);
                _remoteFiles = _knownRemoteKeys.Count;
            }
            var tombstones = await LoadTombstonesAsync(remote, remoteObjects, syncCancellationToken);
            RaiseStateChanged();

            foreach (var tombstone in tombstones.Values)
            {
                syncCancellationToken.ThrowIfCancellationRequested();
                var localPath = LocalPathFromKey(tombstone.ObjectKey);
                if (File.Exists(localPath))
                {
                    File.Delete(localPath);
                    _localFiles = Math.Max(0, _localFiles - 1);
                    deleted++;
                }
                _catalog.SetSynchronized(tombstone.ObjectKey, TombstoneMarker(tombstone.DeletedUtc));
                if (remoteFiles.ContainsKey(tombstone.ObjectKey))
                {
                    await remote.DeleteAsync(tombstone.ObjectKey, syncCancellationToken);
                    remoteFiles.Remove(tombstone.ObjectKey);
                    RecordRemotePresence(tombstone.ObjectKey, exists: false);
                }
            }

            var localFiles = EnumerateLocalFiles().ToDictionary(path => ObjectKey(RelativePath(path)), StringComparer.Ordinal);
            var compared = 0;
            foreach (var remoteEntry in remoteFiles)
            {
                syncCancellationToken.ThrowIfCancellationRequested();
                ReportComparisonProgress(++compared, remoteFiles.Count);
                var remoteInfo = remoteEntry.Value;
                var localPath = LocalPathFromKey(remoteInfo.Key);
                if (File.Exists(localPath) && remoteInfo.Sha256 is { Length: > 0 } advertisedSha)
                {
                    var existingSha = ComputeSha256(localPath);
                    if (existingSha.Equals(advertisedSha, StringComparison.OrdinalIgnoreCase))
                    {
                        _catalog.SetSynchronized(remoteInfo.Key, existingSha);
                        continue;
                    }
                }
                RemoteMaterial? remoteMaterial = null;
                try
                {
                    remoteMaterial = await MaterializeRemoteAsync(remote, remoteInfo, syncCancellationToken);
                    if (!File.Exists(localPath))
                    {
                        ValidateDownloadedFile(localPath, remoteMaterial.Path);
                        MoveAtomic(remoteMaterial.Path, localPath, overwrite: false);
                        _catalog.SetSynchronized(remoteInfo.Key, remoteMaterial.Sha256);
                        _localFiles++;
                        downloaded++;
                        continue;
                    }

                    var localSha = ComputeSha256(localPath);
                    if (localSha.Equals(remoteMaterial.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        _catalog.SetSynchronized(remoteInfo.Key, localSha);
                        continue;
                    }

                    var baseline = _catalog.SynchronizedSha(remoteInfo.Key);
                    if (baseline is not null && baseline.Equals(localSha, StringComparison.OrdinalIgnoreCase))
                    {
                        ValidateDownloadedFile(localPath, remoteMaterial.Path);
                        MoveAtomic(remoteMaterial.Path, localPath, overwrite: true);
                        _catalog.SetSynchronized(remoteInfo.Key, remoteMaterial.Sha256);
                        downloaded++;
                    }
                    else if (baseline is not null && baseline.Equals(remoteMaterial.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        _catalog.Queue(remoteInfo.Key, RelativePath(localPath), DatasetSyncOperation.Upload, localSha);
                    }
                    else
                    {
                        PreserveConflict(remoteInfo.Key, localPath, localSha, remoteMaterial);
                        conflicts++;
                    }
                }
                catch (Exception error) when (error is IOException or JsonException or InvalidDataException)
                {
                    errors.Add($"{remoteInfo.Key}: {error.Message}");
                }
                finally
                {
                    if (remoteMaterial is not null && File.Exists(remoteMaterial.Path)) File.Delete(remoteMaterial.Path);
                }
            }

            var missingRemote = localFiles
                .Where(item => !remoteFiles.ContainsKey(item.Key) && !tombstones.ContainsKey(item.Key))
                .Select(item => (item.Key, RelativePath(item.Value), DatasetSyncOperation.Upload, (string?)null))
                .ToArray();
            _catalog.QueueMany(missingRemote);
            uploaded += await ProcessPendingCoreAsync(remote, includeDeferred: true, syncCancellationToken);

            _catalog.LastSuccessfulSyncUtc = errors.Count == 0 ? DateTimeOffset.UtcNow : _catalog.LastSuccessfulSyncUtc;
            var remaining = _catalog.Counts();
            _status = errors.Count > 0
                ? $"Sync finished with {errors.Count:N0} errors."
                : conflicts > 0
                    ? $"Sync preserved {conflicts:N0} conflicts for review."
                    : remaining.Pending > 0
                        ? $"Sync finished; {remaining.Pending:N0} operations still need retrying."
                        : "Sync complete. This computer is safe to switch from.";
            return new DatasetSyncResult(uploaded, downloaded, deleted, conflicts, errors);
        }
        finally
        {
            SetRunning(false, _status);
            _remoteGate.Release();
        }
    }

    public async Task KeepLocalAsync(string objectKey, CancellationToken cancellationToken)
    {
        var conflict = _catalog.Conflicts().SingleOrDefault(item => item.ObjectKey == objectKey)
            ?? throw new InvalidOperationException("The selected sync conflict no longer exists.");
        var credentials = LoadCredentials() ?? throw new InvalidOperationException("Dataset sync is not configured.");
        var localPath = LocalPathFromKey(objectKey);
        if (!File.Exists(localPath)) throw new FileNotFoundException("The local conflict file no longer exists.", localPath);
        await _remoteGate.WaitAsync(cancellationToken);
        try
        {
            await using var remote = _remoteFactory.Create(credentials);
            var sha = ComputeSha256(localPath);
            await remote.UploadAsync(objectKey, localPath, sha, cancellationToken);
            await remote.DeleteAsync(TombstoneKey(objectKey), cancellationToken);
            _catalog.SetSynchronized(objectKey, sha);
            RecordRemotePresence(objectKey, exists: true);
            _catalog.RemoveConflict(objectKey);
            TryDelete(conflict.RemoteCopyPath);
            _status = "Conflict resolved by keeping the local copy.";
        }
        finally
        {
            _remoteGate.Release();
            RaiseStateChanged();
        }
    }

    public async Task KeepRemoteAsync(string objectKey, CancellationToken cancellationToken)
    {
        var conflict = _catalog.Conflicts().SingleOrDefault(item => item.ObjectKey == objectKey)
            ?? throw new InvalidOperationException("The selected sync conflict no longer exists.");
        await _remoteGate.WaitAsync(cancellationToken);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var localPath = LocalPathFromKey(objectKey);
            ValidateDownloadedFile(localPath, conflict.RemoteCopyPath);
            MoveAtomic(conflict.RemoteCopyPath, localPath, overwrite: true);
            _catalog.SetSynchronized(objectKey, conflict.RemoteSha256);
            _catalog.RemoveConflict(objectKey);
            _status = "Conflict resolved by keeping the remote copy.";
        }
        finally
        {
            _remoteGate.Release();
            RaiseStateChanged();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        var worker = _workerTask;
        if (worker is not null)
        {
            try { await worker; }
            catch (OperationCanceledException) { }
        }
        await _remoteGate.WaitAsync(CancellationToken.None);
        _remoteGate.Release();
        _lifetime.Dispose();
        _remoteGate.Dispose();
    }

    internal static string ObjectKey(string relativePath) =>
        FilesPrefix + relativePath.Replace('\\', '/').TrimStart('/');

    internal static string TombstoneKey(string objectKey) =>
        TombstonesPrefix + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(objectKey))).ToLowerInvariant() + ".json";

    internal static string ComputeSha256(string path)
    {
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private async Task<int> ProcessPendingCoreAsync(
        IRemoteObjectStore remote,
        bool includeDeferred,
        CancellationToken cancellationToken)
    {
        var completed = 0;
        var operations = _catalog.Pending(includeDeferred);
        await Parallel.ForEachAsync(
            operations,
            new ParallelOptions
            {
                MaxDegreeOfParallelism = MaximumParallelTransfers,
                CancellationToken = cancellationToken,
            },
            async (operation, transferCancellationToken) =>
            {
            try
            {
                if (operation.Operation == DatasetSyncOperation.Upload)
                {
                    var path = Path.Combine(_paths.CameraImportsRoot, operation.RelativePath);
                    if (!File.Exists(path))
                    {
                        _catalog.Queue(operation.ObjectKey, operation.RelativePath, DatasetSyncOperation.Delete, null);
                        return;
                    }
                    var sha = ComputeSha256(path);
                    await remote.UploadAsync(operation.ObjectKey, path, sha, transferCancellationToken);
                    await remote.DeleteAsync(TombstoneKey(operation.ObjectKey), transferCancellationToken);
                    if (!_catalog.Complete(operation, sha)) return;
                    RecordRemotePresence(operation.ObjectKey, exists: true);
                }
                else
                {
                    var tombstone = new DatasetTombstone(1, operation.ObjectKey, DateTimeOffset.UtcNow);
                    var content = JsonSerializer.SerializeToUtf8Bytes(tombstone);
                    var sha = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();
                    await remote.UploadBytesAsync(TombstoneKey(operation.ObjectKey), content, sha, transferCancellationToken);
                    await remote.DeleteAsync(operation.ObjectKey, transferCancellationToken);
                    if (!_catalog.Complete(operation, null)) return;
                    RecordRemotePresence(operation.ObjectKey, exists: false);
                }
                Interlocked.Increment(ref completed);
                ReportTransferProgress();
            }
            catch (OperationCanceledException) when (transferCancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                _catalog.Fail(operation, SafeError(error));
            }
        });
        return completed;
    }

    private void RecordRemotePresence(string objectKey, bool exists)
    {
        lock (_inventoryGate)
        {
            if (exists) _knownRemoteKeys.Add(objectKey);
            else _knownRemoteKeys.Remove(objectKey);
            _remoteFiles = _knownRemoteKeys.Count;
        }
    }

    private void ReportTransferProgress()
    {
        var now = Environment.TickCount64;
        var previous = Interlocked.Read(ref _lastProgressNotificationTicks);
        if (previous != 0 && now - previous < 100) return;
        Interlocked.Exchange(ref _lastProgressNotificationTicks, now);
        var counts = _catalog.Counts();
        _status = counts.Pending > 0
            ? $"Uploading camera dataset files… {counts.Pending:N0} remaining."
            : "Finishing dataset synchronization…";
        RaiseStateChanged();
    }

    private void ReportInventoryProgress(int completed, int total) =>
        ReportPhaseProgress("Reading remote file details", completed, total);

    private void ReportComparisonProgress(int completed, int total) =>
        ReportPhaseProgress("Comparing local and remote files", completed, total);

    private void ReportPhaseProgress(string phase, int completed, int total)
    {
        var now = Environment.TickCount64;
        var previous = Interlocked.Read(ref _lastProgressNotificationTicks);
        if (completed < total && previous != 0 && now - previous < 100) return;
        Interlocked.Exchange(ref _lastProgressNotificationTicks, now);
        _status = total == 0
            ? $"{phase}… none found."
            : $"{phase}… {completed:N0} of {total:N0}.";
        RaiseStateChanged();
    }

    private async Task<Dictionary<string, DatasetTombstone>> LoadTombstonesAsync(
        IRemoteObjectStore remote,
        IReadOnlyList<RemoteDatasetObject> objects,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, DatasetTombstone>(StringComparer.Ordinal);
        foreach (var item in objects.Where(item => item.Key.StartsWith(TombstonesPrefix, StringComparison.Ordinal)))
        {
            var temporary = TemporaryPath();
            try
            {
                await remote.DownloadAsync(item.Key, temporary, cancellationToken);
                var tombstone = JsonSerializer.Deserialize<DatasetTombstone>(await File.ReadAllBytesAsync(temporary, cancellationToken));
                if (tombstone is { SchemaVersion: 1 }
                    && tombstone.ObjectKey.StartsWith(FilesPrefix, StringComparison.Ordinal))
                    result[tombstone.ObjectKey] = tombstone;
            }
            catch (JsonException)
            {
                _status = $"Ignored an invalid remote tombstone: {item.Key}";
            }
            finally
            {
                TryDelete(temporary);
            }
        }
        return result;
    }

    private async Task<RemoteMaterial> MaterializeRemoteAsync(
        IRemoteObjectStore remote,
        RemoteDatasetObject item,
        CancellationToken cancellationToken)
    {
        var temporary = TemporaryPath();
        await remote.DownloadAsync(item.Key, temporary, cancellationToken);
        var computed = ComputeSha256(temporary);
        if (item.Sha256 is not null && !item.Sha256.Equals(computed, StringComparison.OrdinalIgnoreCase))
        {
            TryDelete(temporary);
            throw new InvalidDataException($"Remote hash metadata does not match {item.Key}.");
        }
        return new RemoteMaterial(temporary, computed);
    }

    private void PreserveConflict(string key, string localPath, string localSha, RemoteMaterial remote)
    {
        var relative = RelativePath(localPath);
        var conflictRoot = Path.Combine(_paths.CameraRoot, "sync-conflicts", DateTime.UtcNow.ToString("yyyyMMdd-HHmmssfff"));
        var destination = Path.Combine(conflictRoot, relative + ".remote");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Move(remote.Path, destination, overwrite: false);
        _catalog.AddConflict(new DatasetSyncConflict(
            key, relative, destination, localSha, remote.Sha256, DateTimeOffset.UtcNow));
    }

    private IReadOnlyList<string> EnumerateLocalFiles()
    {
        if (!Directory.Exists(_paths.CameraImportsRoot)) return [];
        return Directory.EnumerateFiles(_paths.CameraImportsRoot, "*", SearchOption.AllDirectories)
            .Where(IsDatasetFile)
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static bool IsDatasetFile(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path))
        || path.EndsWith("._annotations.json", StringComparison.OrdinalIgnoreCase)
        || Path.GetFileName(path).Equals(".deckino-import.json", StringComparison.OrdinalIgnoreCase);

    private string RelativePath(string path)
    {
        var root = Path.GetFullPath(_paths.CameraImportsRoot).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(path);
        if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Only files inside the camera imports directory can be synchronized.");
        return Path.GetRelativePath(_paths.CameraImportsRoot, fullPath);
    }

    private string LocalPathFromKey(string key)
    {
        if (!key.StartsWith(FilesPrefix, StringComparison.Ordinal))
            throw new InvalidDataException("The remote object key is outside the Deckino dataset prefix.");
        var relative = key[FilesPrefix.Length..].Replace('/', Path.DirectorySeparatorChar);
        var invalidCharacters = Path.GetInvalidFileNameChars().ToHashSet();
        var segments = relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0
            || segments.Any(segment => segment is "." or ".." || segment.Any(invalidCharacters.Contains)))
            throw new InvalidDataException("The remote object key contains an invalid Windows path.");
        var candidate = Path.GetFullPath(Path.Combine(_paths.CameraImportsRoot, relative));
        var root = Path.GetFullPath(_paths.CameraImportsRoot).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The remote object key attempts to escape the camera imports directory.");
        return candidate;
    }

    private static void ValidateDownloadedFile(string destinationPath, string temporaryPath)
    {
        if (!destinationPath.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return;
        var content = File.ReadAllBytes(temporaryPath);
        using var document = JsonDocument.Parse(content);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("The downloaded JSON file does not contain an object.");
        if (destinationPath.EndsWith("._annotations.json", StringComparison.OrdinalIgnoreCase))
        {
            var annotation = JsonSerializer.Deserialize<CardAnnotation>(content, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
            if (annotation is null || !CameraAnnotationStore.IsValid(annotation))
                throw new InvalidDataException("The downloaded annotation is not valid.");
        }
        else if (Path.GetFileName(destinationPath).Equals(".deckino-import.json", StringComparison.OrdinalIgnoreCase)
                 && JsonSerializer.Deserialize<CameraImportDescriptor>(content) is null)
        {
            throw new InvalidDataException("The downloaded import descriptor is not valid.");
        }
    }

    private static void MoveAtomic(string source, string destination, bool overwrite)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Move(source, destination, overwrite);
    }

    private static string TemporaryPath()
    {
        var root = Path.Combine(Path.GetTempPath(), "deckino-dataset-sync");
        Directory.CreateDirectory(root);
        return Path.Combine(root, Guid.NewGuid().ToString("N") + ".download");
    }

    private void ScheduleWorker()
    {
        if (Interlocked.Exchange(ref _workerScheduled, 1) != 0) return;
        _workerTask = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(250, _lifetime.Token);
                await ProcessPendingAsync(_lifetime.Token);
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
            catch (Exception error)
            {
                _status = $"Automatic dataset upload failed: {SafeError(error)}";
                RaiseStateChanged();
            }
            finally
            {
                Interlocked.Exchange(ref _workerScheduled, 0);
                if (!_lifetime.IsCancellationRequested && _catalog.Counts().Pending > 0)
                {
                    try { await Task.Delay(TimeSpan.FromSeconds(10), _lifetime.Token); }
                    catch (OperationCanceledException) { }
                    if (!_lifetime.IsCancellationRequested) ScheduleWorker();
                }
            }
        });
    }

    private void SetRunning(bool value, string status)
    {
        _isRunning = value;
        _status = status;
        RaiseStateChanged();
    }

    private void RaiseStateChanged() => StateChanged?.Invoke(this, EventArgs.Empty);
    private string SafeError(Exception error)
    {
        var message = error.Message;
        if (_credentials is { } credentials)
        {
            if (!string.IsNullOrEmpty(credentials.SecretAccessKey))
                message = message.Replace(credentials.SecretAccessKey, "[redacted]", StringComparison.Ordinal);
            if (!string.IsNullOrEmpty(credentials.AccessKeyId))
                message = message.Replace(credentials.AccessKeyId, "[redacted]", StringComparison.Ordinal);
        }
        return message;
    }
    private static string TombstoneMarker(DateTimeOffset timestamp) => "deleted:" + timestamp.ToString("O");
    private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } }

    private sealed record DatasetTombstone(int SchemaVersion, string ObjectKey, DateTimeOffset DeletedUtc);
    private sealed record RemoteMaterial(string Path, string Sha256);
}
