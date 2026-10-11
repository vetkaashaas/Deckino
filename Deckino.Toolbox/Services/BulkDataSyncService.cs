using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Dapper;
using Deckino.Toolbox.Data;

namespace Deckino.Toolbox.Services;

public enum BulkSyncPhase { Checking, Downloading, Importing }

public sealed record BulkSyncStatus(string Stage, long Processed, long? Total, BulkSyncPhase Phase = BulkSyncPhase.Importing);

// One Scryfall bulk file as Scryfall last published it and as this computer last imported it.
public sealed record BulkFreshness(string Type, string RemoteUpdatedAt, string? LocalUpdatedAt, string? SyncedAt)
{
    public bool UpToDate => RemoteUpdatedAt == LocalUpdatedAt;
}

public sealed record BulkSyncResult(
    int CardsImported,
    int SetsUpserted,
    int NoArtCount,
    int OracleCardsImported,
    IReadOnlyList<string> SkippedUpToDate);

public sealed class BulkDataSyncService
{
    private readonly Database _database;
    private readonly ScryfallClient _client;
    private readonly SyncOptions _options;

    public BulkDataSyncService(Database database, ScryfallClient client, SyncOptions options)
    {
        _database = database;
        _client = client;
        _options = options;
    }

    // Runs on the thread pool: Microsoft.Data.Sqlite's async calls complete synchronously, so awaited from the UI
    // thread the whole import (JSON parsing and inserts) would run on it. Progress still reports to the caller's thread.
    public Task<BulkSyncResult> SyncAllAsync(IProgress<BulkSyncStatus> progress, CancellationToken cancellationToken) =>
        Task.Run(() => SyncAllCoreAsync(progress, cancellationToken), cancellationToken);

    private async Task<BulkSyncResult> SyncAllCoreAsync(
        IProgress<BulkSyncStatus> progress,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_options.BulkDirectory);

        progress.Report(new BulkSyncStatus("checking Scryfall", 0, null, BulkSyncPhase.Checking));
        var entries = await GetBulkEntriesAsync(cancellationToken);
        var skipped = new List<string>();
        var cardsImported = 0;
        var setsUpserted = 0;
        var noArt = 0;
        var oracleImported = 0;
        var cardImageCatalogEmpty = await IsCardImageCatalogEmptyAsync();

        // Import oracle rows first so printing rows can safely reference them.
        var oracleCards = entries.FirstOrDefault(e => e.Type == "oracle_cards");
        if (oracleCards is not null && !await IsUpToDateAsync("oracle_cards", oracleCards.UpdatedAt))
        {
            progress.Report(new BulkSyncStatus($"downloading {oracleCards.Type}", 0, null, BulkSyncPhase.Downloading));
            var file = await DownloadToFileAsync(oracleCards, "oracle_cards", progress, cancellationToken);
            progress.Report(new BulkSyncStatus("importing oracle cards", 0, null));
            oracleImported = await ImportOracleCardsAsync(file, progress, cancellationToken);
            File.Delete(file);
            await MarkSyncedAsync("oracle_cards", oracleCards.UpdatedAt);
        }
        else if (oracleCards is not null)
        {
            skipped.Add(oracleCards.Type);
        }

        var uniqueArtwork = entries.FirstOrDefault(e => e.Type == "unique_artwork");
        if (uniqueArtwork is not null && (cardImageCatalogEmpty
            || !await IsUpToDateAsync("unique_artwork", uniqueArtwork.UpdatedAt)))
        {
            progress.Report(new BulkSyncStatus($"downloading {uniqueArtwork.Type}", 0, null, BulkSyncPhase.Downloading));
            var file = await DownloadToFileAsync(uniqueArtwork, "unique_artwork", progress, cancellationToken);
            progress.Report(new BulkSyncStatus("importing cards", 0, null));
            (cardsImported, setsUpserted, noArt) = await ImportUniqueArtworkAsync(file, progress, cancellationToken);
            File.Delete(file);
            await MarkSyncedAsync("unique_artwork", uniqueArtwork.UpdatedAt);
        }
        else if (uniqueArtwork is not null)
        {
            skipped.Add(uniqueArtwork.Type);
        }

        return new BulkSyncResult(cardsImported, setsUpserted, noArt, oracleImported, skipped);
    }

    public static string SanitizeFileName(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            builder.Append(Array.IndexOf(invalid, ch) >= 0 ? '_' : ch);
        }
        return builder.ToString();
    }

    private async Task<List<ScryfallBulkDataEntryDto>> GetBulkEntriesAsync(CancellationToken ct)
    {
        using var response = await _client.GetAsync(
            new Uri("https://api.scryfall.com/bulk-data"),
            HttpCompletionOption.ResponseContentRead,
            ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var result = new List<ScryfallBulkDataEntryDto>();
        foreach (var element in doc.RootElement.GetProperty("data").EnumerateArray())
        {
            result.Add(element.Deserialize<ScryfallBulkDataEntryDto>()!);
        }
        return result;
    }

    private async Task<bool> IsUpToDateAsync(string bulkType, string remoteUpdatedAt)
    {
        await using var connection = _database.OpenConnection();
        var stored = await connection.ExecuteScalarAsync<string>(
            "SELECT updated_at FROM sync_state WHERE bulk_type = $type",
            new { type = bulkType });
        return stored == remoteUpdatedAt;
    }

    private async Task<bool> IsCardImageCatalogEmptyAsync()
    {
        await using var connection = _database.OpenConnection();
        return await connection.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM card_images") == 0;
    }

    // Compares Scryfall's published bulk files with the last import, without downloading anything.
    public async Task<IReadOnlyList<BulkFreshness>> CheckFreshnessAsync(CancellationToken cancellationToken)
    {
        var entries = await GetBulkEntriesAsync(cancellationToken);
        await using var connection = _database.OpenConnection();
        var local = (await connection.QueryAsync<(string Type, string UpdatedAt, string SyncedAt)>(
            "SELECT bulk_type AS Type, updated_at AS UpdatedAt, synced_at AS SyncedAt FROM sync_state"))
            .ToDictionary(row => row.Type);
        return entries
            .Where(entry => entry.Type is "oracle_cards" or "unique_artwork")
            .Select(entry => local.TryGetValue(entry.Type, out var row)
                ? new BulkFreshness(entry.Type, entry.UpdatedAt, row.UpdatedAt, row.SyncedAt)
                : new BulkFreshness(entry.Type, entry.UpdatedAt, null, null))
            .ToArray();
    }

    private async Task MarkSyncedAsync(string bulkType, string updatedAt)
    {
        await using var connection = _database.OpenConnection();
        await connection.ExecuteAsync(
            """
            INSERT INTO sync_state (bulk_type, updated_at, synced_at)
            VALUES ($type, $updated, $synced)
            ON CONFLICT(bulk_type) DO UPDATE SET
              updated_at = $updated,
              synced_at = $synced
            """,
            new { type = bulkType, updated = updatedAt, synced = DateTime.UtcNow.ToString("o") });
    }

    private async Task<string> DownloadToFileAsync(
        ScryfallBulkDataEntryDto entry,
        string name,
        IProgress<BulkSyncStatus> progress,
        CancellationToken ct)
    {
        var path = Path.Combine(_options.BulkDirectory, $"{name}.download");
        using var response = await _client.GetAsync(
            entry.JsonlDownloadUri,
            HttpCompletionOption.ResponseHeadersRead,
            ct);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength;
        await using var source = await response.Content.ReadAsStreamAsync(ct);
        await using var target = File.Create(path);
        var buffer = new byte[1 << 16];
        long written = 0;
        long lastReported = -1;
        int read;
        while ((read = await source.ReadAsync(buffer, ct)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), ct);
            written += read;
            if (written - lastReported > (4 << 20))
            {
                lastReported = written;
                progress.Report(new BulkSyncStatus(
                    $"downloading {name}",
                    written >> 20,
                    total is { } t ? t >> 20 : null,
                    BulkSyncPhase.Downloading));
            }
        }
        return path;
    }

    private async Task<(int Cards, int Sets, int NoArt)> ImportUniqueArtworkAsync(
        string path,
        IProgress<BulkSyncStatus> progress,
        CancellationToken ct)
    {
        var setCounts = new Dictionary<string, (string Name, string? ReleasedAt, long Count)>();
        var ensuredSets = new HashSet<string>();
        var batch = new List<(string Id, string? OracleId, string? IllustrationId, bool IsPaper, string Name, string Set, string Collector, string? Layout, string? Released)>(_options.ImportBatchSize);
        var images = new List<(string ImageId, string ScryfallId, int FaceIndex, string ImageUri, string? IllustrationId)>(_options.ImportBatchSize);
        var listedImages = new HashSet<string>(StringComparer.Ordinal);
        var processed = 0L;
        var noArt = 0;

        await using var connection = _database.OpenConnection();
        await using var transaction = await connection.BeginTransactionAsync(ct);

        using var fileStream = File.OpenRead(path);
        await using var gzip = new GZipStream(fileStream, CompressionMode.Decompress);
        using var reader = new StreamReader(gzip);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }
            ct.ThrowIfCancellationRequested();

            var dto = JsonSerializer.Deserialize<ScryfallCardDto>(line);
            if (dto is null || dto.Set.Length == 0)
            {
                continue;
            }
            processed++;

            var faces = dto.ResolveCardImages();
            if (faces.Count == 0)
            {
                noArt++;
            }
            batch.Add((dto.Id, dto.OracleId, faces.FirstOrDefault()?.IllustrationId ?? dto.IllustrationId, dto.IsAvailableInPaper, dto.Name, dto.Set, dto.CollectorNumber, dto.Layout, dto.ReleasedAt));
            if (dto.IsAvailableInPaper)
            {
                images.AddRange(faces.Select(face =>
                    (face.ImageId, dto.Id, face.FaceIndex, face.ImageUri, face.IllustrationId)));
                listedImages.UnionWith(faces.Select(face => face.ImageId));
            }

            if (setCounts.TryGetValue(dto.Set, out var entry))
            {
                setCounts[dto.Set] = (dto.SetName ?? entry.Name, entry.ReleasedAt ?? dto.ReleasedAt, entry.Count + 1);
            }
            else
            {
                setCounts[dto.Set] = (dto.SetName ?? dto.Set, dto.ReleasedAt, 1);
            }

            if (batch.Count >= _options.ImportBatchSize)
            {
                await EnsureSetsAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, batch, ensuredSets, setCounts);
                await FlushCardsAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, batch);
                await FlushCardImagesAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, images);
                progress.Report(new BulkSyncStatus("importing cards", processed, null));
            }
        }

        if (batch.Count > 0)
        {
            await EnsureSetsAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, batch, ensuredSets, setCounts);
            await FlushCardsAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, batch);
            await FlushCardImagesAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, images);
        }

        // Faces the file no longer lists for a paper printing (a single image now split into faces, a printing gone
        // digital-only) leave the download queue and training.
        var stale = (await connection.QueryAsync<string>("SELECT image_id FROM card_images", transaction: transaction))
            .Where(id => !listedImages.Contains(id)).ToArray();
        foreach (var chunk in stale.Chunk(900))
            await connection.ExecuteAsync("DELETE FROM card_images WHERE image_id IN $ids", new { ids = chunk }, transaction);

        await connection.ExecuteAsync(
            "UPDATE sets SET card_count = (SELECT COUNT(*) FROM cards c WHERE c.set_code = sets.code)",
            transaction);

        await transaction.CommitAsync(ct);
        progress.Report(new BulkSyncStatus("cards imported", processed, null));
        return ((int)processed, setCounts.Count, noArt);
    }

    private static async Task EnsureSetsAsync(
        Microsoft.Data.Sqlite.SqliteConnection connection,
        Microsoft.Data.Sqlite.SqliteTransaction transaction,
        List<(string Id, string? OracleId, string? IllustrationId, bool IsPaper, string Name, string Set, string Collector, string? Layout, string? Released)> batch,
        HashSet<string> ensured,
        Dictionary<string, (string Name, string? ReleasedAt, long Count)> setCounts)
    {
        foreach (var code in batch.Select(r => r.Set).Distinct())
        {
            if (!ensured.Add(code))
            {
                continue;
            }
            var info = setCounts[code];
            await connection.ExecuteAsync(
                """
                INSERT INTO sets (code, name, card_count, released_at)
                VALUES ($code, $name, 0, $released)
                ON CONFLICT(code) DO UPDATE SET
                  name = $name
                """,
                new { code, name = info.Name, released = info.ReleasedAt },
                transaction);
        }
    }

    private async Task FlushCardsAsync(
        Microsoft.Data.Sqlite.SqliteConnection connection,
        Microsoft.Data.Sqlite.SqliteTransaction transaction,
        List<(string Id, string? OracleId, string? IllustrationId, bool IsPaper, string Name, string Set, string Collector, string? Layout, string? Released)> batch)
    {
        const string sql = """
            INSERT INTO cards (scryfall_id, oracle_id, illustration_id, is_paper, name, set_code, collector_number, layout, released_at)
            VALUES ($id, $oracleId, $illustrationId, $isPaper, $name, $set, $collector, $layout, $released)
            ON CONFLICT(scryfall_id) DO UPDATE SET
              oracle_id = $oracleId,
              illustration_id = $illustrationId,
              is_paper = $isPaper,
              name = $name,
              set_code = $set,
              collector_number = $collector,
              layout = $layout,
              released_at = $released
            """;
        await connection.ExecuteAsync(sql, batch.Select(r => new
        {
            id = r.Id,
            oracleId = r.OracleId,
            illustrationId = r.IllustrationId,
            isPaper = r.IsPaper,
            name = r.Name,
            set = r.Set,
            collector = r.Collector,
            layout = r.Layout,
            released = r.Released,
        }), transaction);
        batch.Clear();
    }

    private static async Task FlushCardImagesAsync(
        Microsoft.Data.Sqlite.SqliteConnection connection,
        Microsoft.Data.Sqlite.SqliteTransaction transaction,
        List<(string ImageId, string ScryfallId, int FaceIndex, string ImageUri, string? IllustrationId)> images)
    {
        // A changed image URI means Scryfall replaced the scan, so the cached file is downloaded again.
        const string sql = """
            INSERT INTO card_images
              (image_id, scryfall_id, face_index, illustration_id, image_uri, status, updated_at)
            VALUES ($imageId, $scryfallId, $faceIndex, $illustrationId, $imageUri, 'pending', $now)
            ON CONFLICT(image_id) DO UPDATE SET
              illustration_id = $illustrationId,
              image_uri = $imageUri,
              status = CASE WHEN image_uri = $imageUri THEN status ELSE 'pending' END,
              file_path = CASE WHEN image_uri = $imageUri THEN file_path ELSE NULL END,
              file_bytes = CASE WHEN image_uri = $imageUri THEN file_bytes ELSE NULL END,
              error = CASE WHEN image_uri = $imageUri THEN error ELSE NULL END,
              updated_at = $now
            """;
        await connection.ExecuteAsync(sql, images.Select(image => new
        {
            imageId = image.ImageId,
            scryfallId = image.ScryfallId,
            faceIndex = image.FaceIndex,
            illustrationId = image.IllustrationId,
            imageUri = image.ImageUri,
            now = DateTime.UtcNow.ToString("o"),
        }), transaction);
        images.Clear();
    }

    private async Task<int> ImportOracleCardsAsync(
        string path,
        IProgress<BulkSyncStatus> progress,
        CancellationToken ct)
    {
        var imported = 0L;
        var buffer = new List<object>(_options.ImportBatchSize);

        await using var connection = _database.OpenConnection();
        await using var transaction = await connection.BeginTransactionAsync(ct);

        using var fileStream = File.OpenRead(path);
        await using var gzip = new GZipStream(fileStream, CompressionMode.Decompress);
        using var reader = new StreamReader(gzip);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }
            ct.ThrowIfCancellationRequested();

            var dto = JsonSerializer.Deserialize<ScryfallOracleCardDto>(line);
            if (dto is null)
            {
                continue;
            }
            imported++;
            buffer.Add(new
            {
                id = dto.OracleId,
                dto.Name,
                dto.ManaCost,
                dto.TypeLine,
                dto.OracleText,
            });

            if (buffer.Count >= _options.ImportBatchSize)
            {
                await FlushOracleAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, buffer);
                progress.Report(new BulkSyncStatus("importing oracle cards", imported, null));
            }
        }
        if (buffer.Count > 0)
        {
            await FlushOracleAsync(connection, (Microsoft.Data.Sqlite.SqliteTransaction)transaction, buffer);
        }
        await transaction.CommitAsync(ct);
        return (int)imported;
    }

    private static async Task FlushOracleAsync(
        Microsoft.Data.Sqlite.SqliteConnection connection,
        Microsoft.Data.Sqlite.SqliteTransaction transaction,
        List<object> buffer)
    {
        const string sql = """
            INSERT INTO oracle_cards (oracle_id, name, mana_cost, type_line, oracle_text)
            VALUES ($id, $Name, $ManaCost, $TypeLine, $OracleText)
            ON CONFLICT(oracle_id) DO UPDATE SET
              name = $Name,
              mana_cost = $ManaCost,
              type_line = $TypeLine,
              oracle_text = $OracleText
            """;
        await connection.ExecuteAsync(sql, buffer, transaction);
        buffer.Clear();
    }
}
