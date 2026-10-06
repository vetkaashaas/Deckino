using System.IO;
using System.Net;
using System.Net.Http;
using System.Drawing;
using System.Drawing.Imaging;
using Deckino.Toolbox.Data;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class ExtractionAssetDownloadServiceTests
{
    [Fact]
    public async Task DownloadsFullCardAssetsConcurrentlyAndPersistsEveryResult()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-assets-{Guid.NewGuid():N}");
        try
        {
            var database = new Database(Path.Combine(root, "deckino.db"));
            database.Initialize();
            await SeedAssetsAsync(database, 16);
            var handler = new ConcurrentImageHandler(CreateJpeg());
            using var client = new HttpClient(handler);
            var service = new ExtractionAssetDownloadService(database, new TrainingPaths(root), client);

            var status = await service.DownloadPendingAsync(16, null, CancellationToken.None);

            Assert.Equal(16, status.Downloaded);
            Assert.Equal(0, status.Pending);
            Assert.True(handler.MaximumConcurrency > 1);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task SeedAssetsAsync(Database database, int count)
    {
        await using var connection = database.OpenConnection();
        await using var transaction = await connection.BeginTransactionAsync();
        for (var index = 0; index < count; index++)
        {
            await using var command = connection.CreateCommand();
            command.Transaction = (Microsoft.Data.Sqlite.SqliteTransaction)transaction;
            command.CommandText =
                """
                INSERT OR IGNORE INTO sets (code, name, card_count) VALUES ('tst', 'Test', 0);
                INSERT INTO cards (scryfall_id, name, set_code, collector_number, is_paper)
                VALUES ($id, $name, 'tst', $collector, 1);
                INSERT INTO extraction_full_card_assets
                  (asset_id, scryfall_id, face_index, normal_uri, status, updated_at)
                VALUES ($asset, $id, 0, $uri, 'pending', $updated);
                """;
            command.Parameters.AddWithValue("$id", $"card-{index}");
            command.Parameters.AddWithValue("$name", $"Card {index}");
            command.Parameters.AddWithValue("$collector", index.ToString());
            command.Parameters.AddWithValue("$asset", $"card-{index}:front");
            command.Parameters.AddWithValue("$uri", $"https://example.test/card-{index}.jpg");
            command.Parameters.AddWithValue("$updated", DateTime.UtcNow.ToString("o"));
            await command.ExecuteNonQueryAsync();
        }
        await transaction.CommitAsync();
    }

    private static byte[] CreateJpeg()
    {
        using var source = new Bitmap(64, 64, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(source)) graphics.Clear(System.Drawing.Color.FromArgb(120, 120, 120));
        using var output = new MemoryStream();
        source.Save(output, System.Drawing.Imaging.ImageFormat.Jpeg);
        return output.ToArray();
    }

    private sealed class ConcurrentImageHandler(byte[] image) : HttpMessageHandler
    {
        private int _active;
        private int _maximumConcurrency;

        public int MaximumConcurrency => Volatile.Read(ref _maximumConcurrency);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var active = Interlocked.Increment(ref _active);
            while (true)
            {
                var current = Volatile.Read(ref _maximumConcurrency);
                if (current >= active || Interlocked.CompareExchange(
                        ref _maximumConcurrency, active, current) == current) break;
            }
            try
            {
                await Task.Delay(40, cancellationToken);
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new ByteArrayContent(image),
                };
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }
    }
}
