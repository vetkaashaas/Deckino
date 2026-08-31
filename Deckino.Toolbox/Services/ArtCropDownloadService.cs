using System.IO;
using System.Net.Http;
using System.Threading.Channels;
using Dapper;
using Deckino.Toolbox.Data;

namespace Deckino.Toolbox.Services;

public sealed record ArtSyncStatus(long Done, long Failed, long Pending);

public sealed record ArtSyncResult(long Downloaded, long Failed, int SkippedNoArt, bool Cancelled, long Repaired);

public sealed record ArtReconcileStatus(long Scanned, long Total, long Reconciled);

public sealed record ArtCachePreparation(long Requeued, long Reconciled, int SkippedNoArt);

public sealed class ArtCropDownloadService
{
    private readonly Database _database;
    private readonly ScryfallClient _client;
    private readonly SyncOptions _options;

    private long _done;
    private long _failed;
    private long _pending;

    public ArtCropDownloadService(Database database, ScryfallClient client, SyncOptions options)
    {
        _database = database;
        _client = client;
        _options = options;
    }

    public string CardsDirectory => _options.CardsDirectory;

    public async Task<long> CountPendingAsync()
    {
        await using var connection = _database.OpenConnection();
        return await connection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM art_downloads WHERE status = 'pending'");
    }

    public async Task<long> RepairMissingFilesAsync()
    {
        await using var connection = _database.OpenConnection();
        var rows = (await connection.QueryAsync<(string Id, string? Path)>(
            """
            SELECT scryfall_id AS Id, file_path AS Path
            FROM art_downloads
            WHERE status = 'downloaded'
            """)).AsList();
        var missing = rows
            .Where(r => r.Path is null || !File.Exists(r.Path))
            .Select(r => r.Id)
            .AsList();
        var requeuedFailed = await connection.ExecuteAsync(
            """
            UPDATE art_downloads
            SET status = 'pending', updated_at = $now
            WHERE status = 'failed'
            """,
            new { now = DateTime.UtcNow.ToString("o") });
        if (missing.Count == 0 && requeuedFailed == 0)
        {
            return 0;
        }
        foreach (var chunk in missing.Chunk(900))
        {
            await connection.ExecuteAsync(
                """
                UPDATE art_downloads
                SET status = 'pending', file_path = NULL, file_bytes = NULL, updated_at = $now
                WHERE scryfall_id IN $ids
                """,
                new { now = DateTime.UtcNow.ToString("o"), ids = chunk });
        }
        return missing.Count + requeuedFailed;
    }

    public async Task<ArtCachePreparation> PreparePendingAsync(
        IProgress<ArtReconcileStatus>? progress,
        CancellationToken cancellationToken)
    {
        var requeued = await RepairMissingFilesAsync();
        var skippedNoArt = await EnqueueNewCardsAsync();
        var reconciled = await ReconcileExistingFilesAsync(progress, cancellationToken);
        return new ArtCachePreparation(requeued, reconciled, skippedNoArt);
    }

    public async Task<long> ReconcileExistingFilesAsync(
        IProgress<ArtReconcileStatus>? progress,
        CancellationToken cancellationToken)
    {
        await using var connection = _database.OpenConnection();
        const string pendingSql =
            """
            SELECT d.scryfall_id AS Id,
                   c.set_code AS SetCode,
                   c.collector_number AS CollectorNumber
            FROM art_downloads d
            JOIN cards c ON c.scryfall_id = d.scryfall_id
            WHERE d.status = 'pending'
            ORDER BY d.scryfall_id
            """;
        var rows = (await connection.QueryAsync<(string Id, string SetCode, string CollectorNumber)>(
            new CommandDefinition(pendingSql, cancellationToken: cancellationToken))).AsList();
        if (rows.Count == 0)
        {
            progress?.Report(new ArtReconcileStatus(0, 0, 0));
            return 0;
        }

        var recovered = await Task.Run(() =>
        {
            var matches = new List<(string Id, string Path, long Bytes)>();
            for (var index = 0; index < rows.Count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var row = rows[index];
                var path = DestinationPath(row.SetCode, row.CollectorNumber);
                if (TryGetExistingJpegLength(path, out var bytes)) matches.Add((row.Id, path, bytes));
                if ((index + 1) % 250 == 0 || index + 1 == rows.Count)
                    progress?.Report(new ArtReconcileStatus(index + 1, rows.Count, matches.Count));
            }
            return matches;
        }, cancellationToken);

        if (recovered.Count == 0) return 0;
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string update =
            """
            UPDATE art_downloads
            SET status = 'downloaded', file_path = $Path, file_bytes = $Bytes, updated_at = $Updated
            WHERE scryfall_id = $Id AND status = 'pending'
            """;
        var updated = 0;
        foreach (var chunk in recovered.Chunk(500))
        {
            cancellationToken.ThrowIfCancellationRequested();
            updated += await connection.ExecuteAsync(new CommandDefinition(
                update,
                chunk.Select(item => new
                {
                    item.Id,
                    item.Path,
                    item.Bytes,
                    Updated = DateTime.UtcNow.ToString("o"),
                }),
                transaction,
                cancellationToken: cancellationToken));
        }
        await transaction.CommitAsync(cancellationToken);
        return updated;
    }

    public async Task<ArtSyncResult> RunPendingAsync(
        IProgress<ArtSyncStatus> progress,
        CancellationToken cancellationToken,
        ArtCachePreparation? preparation = null)
    {
        Directory.CreateDirectory(_options.CardsDirectory);

        preparation ??= await PreparePendingAsync(progress: null, cancellationToken: cancellationToken);
        var queue = await LoadQueueAsync(cancellationToken);

        _done = 0;
        _failed = 0;
        _pending = queue.Count;

        await using var baselineConnection = _database.OpenConnection();
        var globalDone = await baselineConnection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM art_downloads WHERE status = 'downloaded'");
        var globalFailed = await baselineConnection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM art_downloads WHERE status = 'failed'");
        progress.Report(new ArtSyncStatus(globalDone, globalFailed, _pending));
        if (queue.Count == 0)
        {
            return new ArtSyncResult(0, 0, preparation.SkippedNoArt, cancellationToken.IsCancellationRequested,
                preparation.Requeued + preparation.Reconciled);
        }

        var channel = Channel.CreateBounded<(string Id, string Uri, string Path)>(queue.Count);
        foreach (var item in queue)
        {
            await channel.Writer.WriteAsync(item, cancellationToken);
        }
        channel.Writer.Complete();

        var workerCount = Math.Min(_options.ImageConcurrency, queue.Count);
        var workers = new Task[workerCount];
        await using var writer = _database.OpenConnection();
        using var writerLock = new SemaphoreSlim(1, 1);
        for (var i = 0; i < workerCount; i++)
        {
            workers[i] = WorkerAsync(channel.Reader, writer, writerLock, progress, globalDone, globalFailed, cancellationToken);
        }
        await Task.WhenAll(workers);

        return new ArtSyncResult(
            Interlocked.Read(ref _done),
            Interlocked.Read(ref _failed),
            preparation.SkippedNoArt,
            cancellationToken.IsCancellationRequested,
            preparation.Requeued + preparation.Reconciled);
    }

    private async Task WorkerAsync(
        ChannelReader<(string Id, string Uri, string Path)> reader,
        Microsoft.Data.Sqlite.SqliteConnection writer,
        SemaphoreSlim writerLock,
        IProgress<ArtSyncStatus> progress,
        long globalDone,
        long globalFailed,
        CancellationToken cancellationToken)
    {
        while (await reader.WaitToReadAsync(CancellationToken.None))
        {
            if (!reader.TryRead(out var item))
            {
                continue;
            }
            if (cancellationToken.IsCancellationRequested)
            {
                Interlocked.Decrement(ref _pending);
                continue;
            }

            var ok = false;
            try
            {
                ok = await DownloadOneAsync(item.Id, item.Uri, item.Path, writer, writerLock, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Interlocked.Decrement(ref _pending);
                continue;
            }
            catch
            {
                ok = false;
            }

            Interlocked.Decrement(ref _pending);
            if (ok)
            {
                Interlocked.Increment(ref _done);
            }
            else
            {
                Interlocked.Increment(ref _failed);
                await MarkFailedAsync(writer, writerLock, item.Id);
            }
            progress.Report(new ArtSyncStatus(
                globalDone + Interlocked.Read(ref _done),
                globalFailed + Interlocked.Read(ref _failed),
                Interlocked.Read(ref _pending)));
        }
    }

    private async Task<bool> DownloadOneAsync(
        string scryfallId,
        string uri,
        string destinationPath,
        Microsoft.Data.Sqlite.SqliteConnection writer,
        SemaphoreSlim writerLock,
        CancellationToken ct)
    {
        using var response = await _client.GetAsync(
            new Uri(uri),
            HttpCompletionOption.ResponseHeadersRead,
            ct);
        if (!response.IsSuccessStatusCode)
        {
            return false;
        }
        var expectedLength = response.Content.Headers.ContentLength;
        await using var source = await response.Content.ReadAsStreamAsync(ct);

        var head = new byte[2];
        await source.ReadExactlyAsync(head, ct);
        if (head[0] != 0xFF || head[1] != 0xD8)
        {
            return false;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
        await using var target = File.Create(destinationPath);
        await target.WriteAsync(head, ct);
        long bytes = 2;
        var buffer = new byte[1 << 14];
        int read;
        while ((read = await source.ReadAsync(buffer, ct)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), ct);
            bytes += read;
        }
        if (bytes < 1024 || (expectedLength is { } expected && bytes != expected))
        {
            return false;
        }

        await writerLock.WaitAsync(ct);
        try
        {
            await writer.ExecuteAsync(
                """
                UPDATE art_downloads
                SET status = 'downloaded', file_path = $path, file_bytes = $bytes, updated_at = $now
                WHERE scryfall_id = $id
                """,
                new
                {
                    path = destinationPath,
                    bytes,
                    now = DateTime.UtcNow.ToString("o"),
                    id = scryfallId,
                });
        }
        finally
        {
            writerLock.Release();
        }
        return true;
    }

    private async Task MarkFailedAsync(
        Microsoft.Data.Sqlite.SqliteConnection writer,
        SemaphoreSlim writerLock,
        string scryfallId)
    {
        try
        {
            await writerLock.WaitAsync();
            try
            {
                await writer.ExecuteAsync(
                    "UPDATE art_downloads SET status = 'failed', updated_at = $now WHERE scryfall_id = $id",
                    new { now = DateTime.UtcNow.ToString("o"), id = scryfallId });
            }
            finally
            {
                writerLock.Release();
            }
        }
        catch
        {
        }
    }

    private async Task<int> EnqueueNewCardsAsync()
    {
        await using var connection = _database.OpenConnection();
        var noArt = await connection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM cards c WHERE c.art_crop_uri IS NULL");
        await connection.ExecuteAsync(
            """
            INSERT INTO art_downloads (scryfall_id, status, updated_at)
            SELECT c.scryfall_id, 'pending', $now
            FROM cards c
            WHERE c.art_crop_uri IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM art_downloads d WHERE d.scryfall_id = c.scryfall_id)
            """,
            new { now = DateTime.UtcNow.ToString("o") });
        return (int)noArt;
    }

    private async Task<List<(string Id, string Uri, string Path)>> LoadQueueAsync(CancellationToken ct)
    {
        await using var connection = _database.OpenConnection();
        var rows = (await connection.QueryAsync<(string Id, string Uri, string SetCode, string CollectorNumber)>(
            """
            SELECT d.scryfall_id AS Id,
                   c.art_crop_uri AS Uri,
                   c.set_code AS SetCode,
                   c.collector_number AS CollectorNumber
            FROM art_downloads d
            JOIN cards c ON c.scryfall_id = d.scryfall_id
            WHERE d.status = 'pending'
            """)).AsList();
        var result = new List<(string Id, string Uri, string Path)>(rows.Count());
        foreach (var row in rows)
        {
            var path = DestinationPath(row.SetCode, row.CollectorNumber);
            result.Add((row.Id, row.Uri, path));
        }
        return result;
    }

    private string DestinationPath(string? setCode, string? collectorNumber)
    {
        var setDirectory = BulkDataSyncService.SanitizeFileName(setCode ?? "unknown");
        var collector = BulkDataSyncService.SanitizeFileName(collectorNumber ?? "unknown");
        return Path.Combine(_options.CardsDirectory, setDirectory, $"{collector}.jpg");
    }

    private static bool TryGetExistingJpegLength(string path, out long bytes)
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
}
