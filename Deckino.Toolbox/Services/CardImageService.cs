using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Deckino.Toolbox.Data;
using Microsoft.Data.Sqlite;

namespace Deckino.Toolbox.Services;

public sealed record CardImageCacheStatus(long Total, long Downloaded, long Pending, long Failed, long DownloadedBytes)
{
    public double Percent => Total == 0 ? 0 : Downloaded * 100.0 / Total;
}

public sealed record CardImageFailure(string Name, string SetCode, string CollectorNumber, int FaceIndex, string Error);

// Failures lists the faces that failed since the previous report, so none is missed when reports are throttled.
public sealed record CardImageProgress(
    long Downloaded, long Failed, long Remaining, IReadOnlyList<CardImageFailure> Failures);

public sealed record CardImageRunResult(long Downloaded, long Failed, bool Cancelled);

public sealed record CardImageReconcileStatus(long Scanned, long Total, long Recovered);

// FilesRemoved counts the legacy art-crop caches and card images no row uses any more.
public sealed record CardImagePreparation(long FilesRemoved, long BytesRemoved, long Requeued, long Recovered);

/// <summary>
/// Scryfall's full-card image of every paper face, cached under the data root. Recognition references and
/// extraction scenes both read these. Paths in <c>card_images.file_path</c> are relative to the data root.
/// </summary>
public sealed class CardImageService(Database database, ScryfallClient client, SyncOptions options)
{
    private const string Folder = "card-images";

    // Caches from before full-card references: art crops, and the extraction scene cards that were downloaded
    // separately. Both are replaced by card-images.
    private static readonly string[] LegacyFolders = ["cards", Path.Combine("training", "extraction", "full-cards")];

    public string ImagesDirectory => Path.Combine(options.DataRoot, Folder);

    public string AbsolutePath(string relativePath) => AbsolutePath(options.DataRoot, relativePath);

    public static string AbsolutePath(string dataRoot, string relativePath) =>
        Path.Combine(dataRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));

    public async Task<CardImageCacheStatus> InspectAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = database.OpenConnection();
        var rows = (await connection.QueryAsync<(string Status, long Count, long Bytes)>(new CommandDefinition(
            """
            SELECT status AS Status, COUNT(*) AS Count, COALESCE(SUM(file_bytes), 0) AS Bytes
            FROM card_images GROUP BY status
            """, cancellationToken: cancellationToken))).ToArray();
        long Count(string status) => rows.Where(row => row.Status == status).Sum(row => row.Count);
        return new(rows.Sum(row => row.Count), Count("downloaded"), Count("pending"), Count("failed"),
            rows.Where(row => row.Status == "downloaded").Sum(row => row.Bytes));
    }

    /// <summary>
    /// Gets the queue ready: removes the legacy caches, re-queues downloaded faces whose file is gone (and failed
    /// faces when <paramref name="retryFailed"/>), and marks pending faces whose file is already on disk as downloaded.
    /// Failed faces otherwise stay failed with their reason, so a face Scryfall no longer serves is not asked for on
    /// every sync.
    /// </summary>
    /// <remarks>
    /// Runs on the thread pool: Microsoft.Data.Sqlite's async calls complete synchronously, so the database and file
    /// work would otherwise block a UI caller.
    /// </remarks>
    public Task<CardImagePreparation> PrepareAsync(
        bool retryFailed, IProgress<CardImageReconcileStatus>? progress, CancellationToken cancellationToken) =>
        Task.Run(() => PrepareCoreAsync(retryFailed, progress, cancellationToken), cancellationToken);

    private async Task<CardImagePreparation> PrepareCoreAsync(
        bool retryFailed, IProgress<CardImageReconcileStatus>? progress, CancellationToken cancellationToken)
    {
        var (legacyFiles, legacyBytes) = RemoveLegacyCaches();
        var requeued = await RequeueAsync(retryFailed, cancellationToken);
        var recovered = await ReconcileExistingFilesAsync(progress, cancellationToken);
        var (unusedFiles, unusedBytes) = await RemoveUnusedImagesAsync(cancellationToken);
        return new(legacyFiles + unusedFiles, legacyBytes + unusedBytes, requeued, recovered);
    }

    // Files of faces the catalogue dropped or whose scan Scryfall replaced (the name carries the old URI's hash), and
    // interrupted downloads. Runs after reconciling, so every file a row can use is referenced by then.
    private async Task<(long Files, long Bytes)> RemoveUnusedImagesAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(ImagesDirectory)) return (0, 0);
        await using var connection = database.OpenConnection();
        var used = (await connection.QueryAsync<string>(new CommandDefinition(
                "SELECT file_path FROM card_images WHERE file_path IS NOT NULL", cancellationToken: cancellationToken)))
            .Select(path => Path.GetFullPath(AbsolutePath(path)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return await Task.Run(() =>
        {
            long files = 0, bytes = 0;
            foreach (var file in new DirectoryInfo(ImagesDirectory).EnumerateFiles("*", SearchOption.AllDirectories))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (used.Contains(file.FullName)) continue;
                try
                {
                    var length = file.Length;
                    file.Delete();
                    files++;
                    bytes += length;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    // Open elsewhere; the next sync removes it.
                }
            }
            return (files, bytes);
        }, cancellationToken);
    }

    private (long Files, long Bytes) RemoveLegacyCaches()
    {
        long files = 0, bytes = 0;
        foreach (var folder in LegacyFolders.Select(name => Path.Combine(options.DataRoot, name)))
        {
            if (!Directory.Exists(folder)) continue;
            foreach (var file in new DirectoryInfo(folder).EnumerateFiles("*", SearchOption.AllDirectories))
            {
                files++;
                bytes += file.Length;
            }
            Directory.Delete(folder, recursive: true);
        }
        return (files, bytes);
    }

    private async Task<long> RequeueAsync(bool retryFailed, CancellationToken cancellationToken)
    {
        await using var connection = database.OpenConnection();
        var downloaded = (await connection.QueryAsync<(string Id, string Path)>(new CommandDefinition(
            "SELECT image_id AS Id, file_path AS Path FROM card_images WHERE status = 'downloaded'",
            cancellationToken: cancellationToken))).AsList();
        var missing = downloaded.Where(row => row.Path is null || !File.Exists(AbsolutePath(row.Path)))
            .Select(row => row.Id).ToArray();
        var now = DateTime.UtcNow.ToString("o");
        long requeued = retryFailed
            ? await connection.ExecuteAsync(
                "UPDATE card_images SET status = 'pending', error = NULL, updated_at = $now WHERE status = 'failed'",
                new { now })
            : 0;
        foreach (var chunk in missing.Chunk(900))
        {
            requeued += await connection.ExecuteAsync(
                """
                UPDATE card_images SET status = 'pending', file_path = NULL, file_bytes = NULL, updated_at = $now
                WHERE image_id IN $ids
                """, new { now, ids = chunk });
        }
        return requeued;
    }

    private async Task<long> ReconcileExistingFilesAsync(
        IProgress<CardImageReconcileStatus>? progress, CancellationToken cancellationToken)
    {
        await using var connection = database.OpenConnection();
        var pending = (await LoadPendingAsync(connection, null, cancellationToken)).ToArray();
        if (pending.Length == 0)
        {
            progress?.Report(new(0, 0, 0));
            return 0;
        }
        var found = await Task.Run(() =>
        {
            var matches = new List<(string Id, string Path, long Bytes)>();
            for (var index = 0; index < pending.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var relative = RelativePath(pending[index]);
                if (TryGetCompleteJpegLength(AbsolutePath(relative), out var bytes))
                    matches.Add((pending[index].ImageId, relative, bytes));
                if ((index + 1) % 250 == 0 || index + 1 == pending.Length)
                    progress?.Report(new(index + 1, pending.Length, matches.Count));
            }
            return matches;
        }, cancellationToken);
        if (found.Count == 0) return 0;
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var now = DateTime.UtcNow.ToString("o");
        var updated = await connection.ExecuteAsync(new CommandDefinition(
            """
            UPDATE card_images
            SET status = 'downloaded', file_path = $Path, file_bytes = $Bytes, error = NULL, updated_at = $Now
            WHERE image_id = $Id AND status = 'pending'
            """, found.Select(item => new { item.Id, item.Path, item.Bytes, Now = now }), transaction,
            cancellationToken: cancellationToken));
        await transaction.CommitAsync(cancellationToken);
        return updated;
    }

    /// <summary>Downloads pending faces, at most <paramref name="maximum"/> when given.</summary>
    /// <remarks>Runs on the thread pool, like <see cref="PrepareAsync"/>.</remarks>
    public Task<CardImageRunResult> DownloadPendingAsync(
        int? maximum, IProgress<CardImageProgress>? progress, CancellationToken cancellationToken) =>
        Task.Run(() => DownloadPendingCoreAsync(maximum, progress, cancellationToken), cancellationToken);

    // At over a hundred images a second, reporting each one floods the caller's UI thread with updates.
    private const long ProgressIntervalMs = 100;

    private async Task<CardImageRunResult> DownloadPendingCoreAsync(
        int? maximum, IProgress<CardImageProgress>? progress, CancellationToken cancellationToken)
    {
        await using var writer = database.OpenConnection();
        var queue = (await LoadPendingAsync(writer, maximum, cancellationToken)).ToArray();
        if (queue.Length == 0) return new(0, 0, cancellationToken.IsCancellationRequested);
        long downloaded = 0, failed = 0, lastReport = 0, reportedFinished = -1;
        using var writerLock = new SemaphoreSlim(1, 1);
        var reportLock = new object();
        var newFailures = new ConcurrentQueue<CardImageFailure>();
        try
        {
            await Parallel.ForEachAsync(queue, new ParallelOptions
            {
                MaxDegreeOfParallelism = Math.Min(options.ImageConcurrency, queue.Length),
                CancellationToken = cancellationToken,
            }, async (face, token) =>
            {
                var relative = RelativePath(face);
                string? error;
                long bytes = 0;
                try
                {
                    bytes = await DownloadOneAsync(face.ImageUri, AbsolutePath(relative), token);
                    error = null;
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    // One face failing (a timeout, which surfaces as a cancellation nobody asked for, an HTTP error,
                    // a file the disk refused) is recorded against that face; the rest keep downloading.
                    error = exception is OperationCanceledException ? "timed out" : exception.Message;
                }
                await writerLock.WaitAsync(CancellationToken.None);
                try
                {
                    await writer.ExecuteAsync(error is null
                        ? """
                          UPDATE card_images
                          SET status = 'downloaded', file_path = $relative, file_bytes = $bytes, error = NULL,
                              updated_at = $now
                          WHERE image_id = $id
                          """
                        : "UPDATE card_images SET status = 'failed', error = $error, updated_at = $now WHERE image_id = $id",
                        new { relative = relative, bytes, error, now = DateTime.UtcNow.ToString("o"), id = face.ImageId });
                }
                finally
                {
                    writerLock.Release();
                }
                // Queued before it is counted, so the report that sees the final count carries it.
                if (error is not null)
                    newFailures.Enqueue(new(face.Name, face.SetCode, face.CollectorNumber, (int)face.FaceIndex, error));
                var done = error is null ? Interlocked.Increment(ref downloaded) : Interlocked.Read(ref downloaded);
                var lost = error is null ? Interlocked.Read(ref failed) : Interlocked.Increment(ref failed);
                // The last face always reports; the rest at most every ProgressIntervalMs, failures included (a lost
                // connection fails thousands in seconds). Each report carries the failures queued since the last.
                var now = Environment.TickCount64;
                var last = Interlocked.Read(ref lastReport);
                var due = done + lost == queue.Length
                    || (now - last >= ProgressIntervalMs && Interlocked.CompareExchange(ref lastReport, now, last) == last);
                if (!due || progress is null) return;
                // Counts are read and reported under the lock, so reports leave in order and never step back.
                lock (reportLock)
                {
                    var (ok, bad) = (Interlocked.Read(ref downloaded), Interlocked.Read(ref failed));
                    if (ok + bad <= reportedFinished) return;
                    reportedFinished = ok + bad;
                    var failures = new List<CardImageFailure>();
                    while (newFailures.TryDequeue(out var failure)) failures.Add(failure);
                    progress.Report(new(ok, bad, queue.Length - ok - bad, failures));
                }
            });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return new(Interlocked.Read(ref downloaded), Interlocked.Read(ref failed), true);
        }
        return new(downloaded, failed, false);
    }

    private async Task<long> DownloadOneAsync(string uri, string destination, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(new Uri(uri), HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"HTTP {(int)response.StatusCode} {response.ReasonPhrase}");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + ".download";
        try
        {
            await using (var source = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var target = File.Create(temporary))
                await source.CopyToAsync(target, cancellationToken);
            if (!TryGetCompleteJpegLength(temporary, out var bytes))
                throw new InvalidDataException("not a complete JPEG");
            File.Move(temporary, destination, overwrite: true);
            return bytes;
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    // Pending faces in image-id order, which is Scryfall-id order: effectively random across sets, so a capped
    // download (extraction's first scenes) still samples the whole catalogue.
    private static async Task<IEnumerable<PendingFace>> LoadPendingAsync(
        SqliteConnection connection, int? maximum, CancellationToken cancellationToken) =>
        await connection.QueryAsync<PendingFace>(new CommandDefinition(
            """
            SELECT i.image_id AS ImageId, i.image_uri AS ImageUri, i.face_index AS FaceIndex,
                   c.name AS Name, c.set_code AS SetCode, c.collector_number AS CollectorNumber
            FROM card_images i JOIN cards c ON c.scryfall_id = i.scryfall_id
            WHERE i.status = 'pending'
            ORDER BY i.image_id
            LIMIT $limit
            """, new { limit = maximum ?? -1 }, cancellationToken: cancellationToken));

    private static string RelativePath(PendingFace face) =>
        RelativePath(face.SetCode, face.CollectorNumber, face.FaceIndex, face.ImageUri);

    // The name carries a hash of the image URI: when Scryfall replaces a scan (a new URI) the old file is never
    // mistaken for the new one, and two image rows of one face never share a file.
    internal static string RelativePath(string setCode, string collectorNumber, long faceIndex, string imageUri) =>
        $"{Folder}/{BulkDataSyncService.SanitizeFileName(setCode)}/"
        + $"{BulkDataSyncService.SanitizeFileName(collectorNumber)}-{faceIndex}-"
        + $"{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(imageUri)))[..8]}.jpg";

    private static bool TryGetCompleteJpegLength(string path, out long bytes)
    {
        bytes = 0;
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length < 1024) return false;
            using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.ReadByte() != 0xFF || stream.ReadByte() != 0xD8) return false;
            stream.Seek(-2, SeekOrigin.End);
            if (stream.ReadByte() != 0xFF || stream.ReadByte() != 0xD9) return false;
            bytes = file.Length;
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private sealed record PendingFace(
        string ImageId, string ImageUri, long FaceIndex, string Name, string SetCode, string CollectorNumber)
    {
        public PendingFace() : this("", "", 0, "", "", "") { }
    }
}
