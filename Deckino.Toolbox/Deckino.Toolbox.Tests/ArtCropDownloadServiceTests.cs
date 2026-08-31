using Dapper;
using Deckino.Toolbox.Data;
using Deckino.Toolbox.Services;
using Microsoft.Data.Sqlite;

namespace Deckino.Toolbox.Tests;

public sealed class ArtCropDownloadServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "deckino-art-reconcile-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task ReconcilesValidExistingPendingCropWithoutDownloadingItAgain()
    {
        var database = CreateDatabase();
        await SeedPendingCardAsync(database, "card-1", "tst", "42");
        var expectedPath = Path.Combine(_root, "cards", "tst", "42.jpg");
        WriteJpegLikeFile(expectedPath, validEndMarker: true);
        using var client = new ScryfallClient(0);
        var service = new ArtCropDownloadService(database, client, new SyncOptions { DataRoot = _root });

        var preparation = await service.PreparePendingAsync(null, CancellationToken.None);

        Assert.Equal(1, preparation.Reconciled);
        Assert.Equal(0, await service.CountPendingAsync());
        await using var connection = database.OpenConnection();
        var row = await connection.QuerySingleAsync<(string Status, string Path, long Bytes)>(
            "SELECT status AS Status, file_path AS Path, file_bytes AS Bytes FROM art_downloads WHERE scryfall_id = 'card-1'");
        Assert.Equal("downloaded", row.Status);
        Assert.Equal(expectedPath, row.Path);
        Assert.Equal(new FileInfo(expectedPath).Length, row.Bytes);
    }

    [Fact]
    public async Task LeavesIncompleteExistingCropPendingForARealDownload()
    {
        var database = CreateDatabase();
        await SeedPendingCardAsync(database, "card-2", "tst", "43");
        var expectedPath = Path.Combine(_root, "cards", "tst", "43.jpg");
        WriteJpegLikeFile(expectedPath, validEndMarker: false);
        using var client = new ScryfallClient(0);
        var service = new ArtCropDownloadService(database, client, new SyncOptions { DataRoot = _root });

        var preparation = await service.PreparePendingAsync(null, CancellationToken.None);

        Assert.Equal(0, preparation.Reconciled);
        Assert.Equal(1, await service.CountPendingAsync());
    }

    private Database CreateDatabase()
    {
        var database = new Database(Path.Combine(_root, "deckino.db"));
        database.Initialize();
        return database;
    }

    private static async Task SeedPendingCardAsync(
        Database database,
        string cardId,
        string setCode,
        string collectorNumber)
    {
        await using var connection = database.OpenConnection();
        await connection.ExecuteAsync(
            """
            INSERT INTO sets (code, name, card_count) VALUES ($setCode, 'Test', 1);
            INSERT INTO cards
              (scryfall_id, name, set_code, collector_number, is_paper, art_crop_uri)
            VALUES ($cardId, 'Card', $setCode, $collectorNumber, 1, 'https://example.test/card.jpg');
            INSERT INTO art_downloads (scryfall_id, status, updated_at)
            VALUES ($cardId, 'pending', $updated);
            """,
            new { cardId, setCode, collectorNumber, updated = DateTime.UtcNow.ToString("o") });
    }

    private static void WriteJpegLikeFile(string path, bool validEndMarker)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var bytes = new byte[2048];
        bytes[0] = 0xFF;
        bytes[1] = 0xD8;
        bytes[^2] = validEndMarker ? (byte)0xFF : (byte)0;
        bytes[^1] = validEndMarker ? (byte)0xD9 : (byte)0;
        File.WriteAllBytes(path, bytes);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
