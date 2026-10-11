using System.Net;
using System.Net.Http;
using Dapper;
using Deckino.Toolbox.Data;
using Deckino.Toolbox.Services;
using Microsoft.Data.Sqlite;

namespace Deckino.Toolbox.Tests;

public sealed class CardImageServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "deckino-card-image-tests", Guid.NewGuid().ToString("N"));

    // Where the first seeded card's image is cached.
    private static readonly string FirstImage =
        CardImageService.RelativePath("tst", "0", 0, "https://example.test/card-0.jpg");

    [Fact]
    public async Task ReconcilesAValidFileAlreadyOnDiskWithoutDownloadingItAgain()
    {
        var database = CreateDatabase();
        await SeedPendingAsync(database, 1);
        var expected = Path.Combine(_root, FirstImage);
        WriteJpegLikeFile(expected, validEndMarker: true);
        using var client = new ScryfallClient(0);
        var service = new CardImageService(database, client, new SyncOptions { DataRoot = _root });

        var preparation = await service.PrepareAsync(retryFailed: false, null, CancellationToken.None);

        Assert.Equal(1, preparation.Recovered);
        await using var connection = database.OpenConnection();
        var row = await connection.QuerySingleAsync<(string Status, string Path, long Bytes)>(
            "SELECT status AS Status, file_path AS Path, file_bytes AS Bytes FROM card_images");
        Assert.Equal("downloaded", row.Status);
        Assert.Equal(FirstImage, row.Path);
        Assert.Equal(new FileInfo(expected).Length, row.Bytes);
    }

    [Fact]
    public async Task LeavesAnIncompleteFilePendingForARealDownload()
    {
        var database = CreateDatabase();
        await SeedPendingAsync(database, 1);
        WriteJpegLikeFile(Path.Combine(_root, FirstImage), validEndMarker: false);
        using var client = new ScryfallClient(0);
        var service = new CardImageService(database, client, new SyncOptions { DataRoot = _root });

        var preparation = await service.PrepareAsync(retryFailed: false, null, CancellationToken.None);

        Assert.Equal(0, preparation.Recovered);
        Assert.Equal(1, (await service.InspectAsync()).Pending);
    }

    [Fact]
    public async Task RemovesTheLegacyArtCropAndExtractionCaches()
    {
        var database = CreateDatabase();
        WriteJpegLikeFile(Path.Combine(_root, "cards", "tst", "1.jpg"), validEndMarker: true);
        WriteJpegLikeFile(Path.Combine(_root, "training", "extraction", "full-cards", "tst", "a.jpg"), validEndMarker: true);
        using var client = new ScryfallClient(0);
        var service = new CardImageService(database, client, new SyncOptions { DataRoot = _root });

        var preparation = await service.PrepareAsync(retryFailed: false, null, CancellationToken.None);

        Assert.Equal(2, preparation.FilesRemoved);
        Assert.False(Directory.Exists(Path.Combine(_root, "cards")));
        Assert.False(Directory.Exists(Path.Combine(_root, "training", "extraction", "full-cards")));
        Assert.True(Directory.Exists(Path.Combine(_root, "training", "extraction")));
    }

    [Fact]
    public async Task DownloadsConcurrentlyAndRecordsFailuresWithTheirReason()
    {
        var database = CreateDatabase();
        await SeedPendingAsync(database, 16);
        var handler = new ImageHandler(JpegBytes(), failingPath: "/card-3.jpg");
        using var client = new ScryfallClient(0, handler);
        var service = new CardImageService(database, client, new SyncOptions { DataRoot = _root });
        var reports = new List<CardImageProgress>();

        var result = await service.DownloadPendingAsync(null, new SynchronousProgress(reports), CancellationToken.None);

        Assert.Equal(15, result.Downloaded);
        Assert.Equal(1, result.Failed);
        Assert.True(handler.MaximumConcurrency > 1);
        // Throttled, but the final count always arrives.
        Assert.Contains(reports, report => report is { Downloaded: 15, Failed: 1, Remaining: 0 });
        var failure = Assert.Single(reports.SelectMany(report => report.Failures));
        Assert.Equal("Card 3", failure.Name);
        Assert.Contains("404", failure.Error, StringComparison.Ordinal);
        var status = await service.InspectAsync();
        Assert.Equal(15, status.Downloaded);
        Assert.True(File.Exists(Path.Combine(_root, FirstImage)));
    }

    private Database CreateDatabase()
    {
        var database = new Database(Path.Combine(_root, "deckino.db"));
        database.Initialize();
        return database;
    }

    private static async Task SeedPendingAsync(Database database, int count)
    {
        await using var connection = database.OpenConnection();
        await connection.ExecuteAsync("INSERT INTO sets (code, name, card_count) VALUES ('tst', 'Test', 0)");
        for (var index = 0; index < count; index++)
        {
            await connection.ExecuteAsync(
                """
                INSERT INTO cards (scryfall_id, name, set_code, collector_number, is_paper)
                VALUES ($id, $name, 'tst', $collector, 1);
                INSERT INTO card_images (image_id, scryfall_id, face_index, image_uri, status, updated_at)
                VALUES ($image, $id, 0, $uri, 'pending', $updated);
                """,
                new
                {
                    id = $"card-{index:00}",
                    name = $"Card {index}",
                    collector = index.ToString(),
                    image = $"card-{index:00}:front",
                    uri = $"https://example.test/card-{index}.jpg",
                    updated = DateTime.UtcNow.ToString("o"),
                });
        }
    }

    private static byte[] JpegBytes()
    {
        var bytes = new byte[4096];
        bytes[0] = 0xFF;
        bytes[1] = 0xD8;
        bytes[^2] = 0xFF;
        bytes[^1] = 0xD9;
        return bytes;
    }

    private static void WriteJpegLikeFile(string path, bool validEndMarker)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var bytes = JpegBytes();
        if (!validEndMarker) bytes[^1] = 0;
        File.WriteAllBytes(path, bytes);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class SynchronousProgress(List<CardImageProgress> reports) : IProgress<CardImageProgress>
    {
        public void Report(CardImageProgress value)
        {
            lock (reports) reports.Add(value);
        }
    }

    private sealed class ImageHandler(byte[] image, string failingPath) : HttpMessageHandler
    {
        private int _active;
        private int _maximumConcurrency;

        public int MaximumConcurrency => Volatile.Read(ref _maximumConcurrency);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var active = Interlocked.Increment(ref _active);
            while (true)
            {
                var current = Volatile.Read(ref _maximumConcurrency);
                if (current >= active
                    || Interlocked.CompareExchange(ref _maximumConcurrency, active, current) == current) break;
            }
            try
            {
                await Task.Delay(40, cancellationToken);
                return request.RequestUri!.AbsolutePath == failingPath
                    ? new HttpResponseMessage(HttpStatusCode.NotFound) { ReasonPhrase = "Not Found" }
                    : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(image) };
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }
    }
}
