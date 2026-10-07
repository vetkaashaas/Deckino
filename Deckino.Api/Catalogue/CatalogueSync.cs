using System.IO.Compression;
using System.Text.Json;
using Deckino.Api.Data;
using Deckino.Api.Prices;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Deckino.Api.Catalogue;

// Keeps the cards table in step with Scryfall's default_cards bulk file: checks on startup and every
// few hours, and imports only when Scryfall's updated_at has changed. Catalogue:BulkFile points it at a
// local .jsonl.gz instead (the E2E fixture), which goes through exactly the same import.
public sealed class CatalogueSync(
    IServiceScopeFactory scopes,
    IHttpClientFactory httpClients,
    IConfiguration configuration,
    ILogger<CatalogueSync> logger) : BackgroundService
{
    public const string HttpClientName = "scryfall";
    private static readonly TimeSpan Interval = TimeSpan.FromHours(4);
    // Body reads of a streamed download have no HttpClient timeout; a stalled connection must not hold
    // the gate and an open transaction forever. A full import normally takes about 10 seconds.
    private static readonly TimeSpan ImportDeadline = TimeSpan.FromMinutes(30);
    private readonly SemaphoreSlim _gate = new(1, 1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                await RunAsync(force: false, stoppingToken);
            }
            catch (Exception e) when (!stoppingToken.IsCancellationRequested)
            {
                // The transaction rolled back, so the previous catalogue is intact; the next tick retries.
                logger.LogError(e, "Catalogue sync failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    // Returns the recorded run, or null when the catalogue was already up to date.
    public async Task<CatalogueSyncRun?> RunAsync(bool force, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var (updatedAt, open) = await GetBulkFileAsync(ct);
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<DeckinoDbContext>();

            if (!force && await db.CatalogueSyncRuns.AnyAsync(
                    r => r.BulkUpdatedAt == updatedAt && r.FinishedAt != null && r.Error == null, ct))
            {
                logger.LogInformation("Catalogue is up to date with bulk data from {UpdatedAt}", updatedAt);
                if (!await PriceEndpoints.HasSnapshotTodayAsync(db, ct)) await SnapshotPricesAsync(db, ct);
                return null;
            }

            var run = new CatalogueSyncRun { StartedAt = DateTimeOffset.UtcNow, BulkUpdatedAt = updatedAt };
            db.CatalogueSyncRuns.Add(run);
            await db.SaveChangesAsync(ct);
            logger.LogInformation("Catalogue sync {RunId} started for bulk data from {UpdatedAt}", run.Id, updatedAt);
            try
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                deadline.CancelAfter(ImportDeadline);
                await using var stream = await open(deadline.Token);
                await ImportAsync(db, stream, run, deadline.Token);
                logger.LogInformation(
                    "Catalogue sync {RunId} finished: {Read} read, {Digital} digital skipped, {Inserted} inserted, {Updated} updated, {Missing} missing upstream",
                    run.Id, run.CardsRead, run.DigitalSkipped, run.Inserted, run.Updated, run.MissingUpstream);
            }
            catch (Exception e)
            {
                run.Error = e.Message;
                throw;
            }
            finally
            {
                run.FinishedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(CancellationToken.None);
            }
            await SnapshotPricesAsync(db, ct);
            return run;
        }
        finally
        {
            _gate.Release();
        }
    }

    // Today's price snapshot. A failure is logged, never fails the sync: the next check (within hours) retries.
    private async Task SnapshotPricesAsync(DeckinoDbContext db, CancellationToken ct)
    {
        try
        {
            await PriceEndpoints.SnapshotAsync(db, ct);
            logger.LogInformation("Price snapshot written");
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogError(e, "Price snapshot failed");
        }
    }

    private async Task<(DateTimeOffset UpdatedAt, Func<CancellationToken, Task<Stream>> Open)> GetBulkFileAsync(
        CancellationToken ct)
    {
        if (configuration["Catalogue:BulkFile"] is { } path)
        {
            // Whole seconds, so it compares equal after a round trip through PostgreSQL's microseconds.
            var modified = DateTimeOffset.FromUnixTimeSeconds(
                new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeSeconds());
            return (modified, _ => Task.FromResult<Stream>(File.OpenRead(path)));
        }

        var http = httpClients.CreateClient(HttpClientName);
        var bulk = await http.GetFromJsonAsync<ScryfallBulkData>(
            "https://api.scryfall.com/bulk-data/default_cards", ScryfallCard.Json, ct)
            ?? throw new InvalidDataException("Empty bulk-data response.");
        return (bulk.UpdatedAt, async token =>
        {
            var response = await http.GetAsync(bulk.JsonlDownloadUri, HttpCompletionOption.ResponseHeadersRead, token);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStreamAsync(token);
        });
    }

    // Streams the gzipped JSONL into a temp table, then upserts it in one transaction:
    // a failure anywhere leaves the previous catalogue untouched.
    private static async Task ImportAsync(DeckinoDbContext db, Stream gzipped, CatalogueSyncRun run, CancellationToken ct)
    {
        db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var connection = (NpgsqlConnection)db.Database.GetDbConnection();
        var columns = string.Join(", ", Columns.Select(c => c.Name));

        var createImportTable = $"CREATE TEMP TABLE card_import ON COMMIT DROP AS SELECT {columns} FROM cards WITH NO DATA";
        await db.Database.ExecuteSqlRawAsync(createImportTable, ct);
        await using (var importer = await connection.BeginBinaryImportAsync(
                         $"COPY card_import ({columns}) FROM STDIN (FORMAT BINARY)", ct))
        {
            using var reader = new StreamReader(new GZipStream(gzipped, CompressionMode.Decompress));
            while (await reader.ReadLineAsync(ct) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                var card = JsonSerializer.Deserialize<ScryfallCard>(line, ScryfallCard.Json)!;
                if (card.Digital) // paper only: Arena/MTGO-only printings, Alchemy "A-" cards
                {
                    run.DigitalSkipped++;
                    continue;
                }
                run.CardsRead++;
                await importer.StartRowAsync(ct);
                var row = card.ToCard();
                foreach (var (_, type, value) in Columns)
                {
                    if (value(row) is { } v) await importer.WriteAsync(v, type, ct);
                    else await importer.WriteNullAsync(ct);
                }
            }
            await importer.CompleteAsync(ct);
        }

        var changed = string.Join(", ", Columns.Skip(1).Select(c => $"{c.Name} = excluded.{c.Name}"));
        var current = string.Join(", ", Columns.Skip(1).Select(c => $"cards.{c.Name}"));
        var incoming = string.Join(", ", Columns.Skip(1).Select(c => $"excluded.{c.Name}"));
        await using (var upsert = new NpgsqlCommand(
                         $"""
                          WITH upserted AS (
                            INSERT INTO cards ({columns}, is_default_printing, is_missing_upstream)
                            SELECT {columns}, false, false FROM card_import
                            ON CONFLICT (id) DO UPDATE SET {changed}
                            WHERE ({current}) IS DISTINCT FROM ({incoming})
                            RETURNING xmax = 0 AS inserted)
                          SELECT count(*) FILTER (WHERE inserted)::int, count(*) FILTER (WHERE NOT inserted)::int
                          FROM upserted
                          """, connection) { CommandTimeout = 600 })
        await using (var result = await upsert.ExecuteReaderAsync(ct))
        {
            await result.ReadAsync(ct);
            run.Inserted = result.GetInt32(0);
            run.Updated = result.GetInt32(1);
        }

        // Printings that vanished upstream are flagged, never deleted.
        await db.Database.ExecuteSqlRawAsync(
            """
            UPDATE cards SET is_missing_upstream = m.missing
            FROM (SELECT c.id, i.id IS NULL AS missing FROM cards c LEFT JOIN card_import i ON i.id = c.id) m
            WHERE cards.id = m.id AND cards.is_missing_upstream <> m.missing
            """, ct);
        run.MissingUpstream = await db.Cards.CountAsync(c => c.IsMissingUpstream, ct);
        await db.Database.ExecuteSqlRawAsync(DefaultPrintingSql, ct);
        await transaction.CommitAsync(ct);
    }

    // The default printing rule, in one place: per Oracle ID, the latest printing that is English, not full
    // art, not Secret Lair, not a promo/oversized/token/art-series/memorabilia card; otherwise the latest of any.
    private const string DefaultPrintingSql =
        """
        UPDATE cards SET is_default_printing = (cards.id = d.id)
        FROM (
          SELECT DISTINCT ON (oracle_id) oracle_id, id FROM cards
          ORDER BY oracle_id,
            is_missing_upstream,
            (lang = 'en' AND NOT full_art AND set_code <> 'sld' AND NOT promo AND NOT oversized
              AND set_type NOT IN ('token', 'memorabilia')
              AND layout NOT IN ('token', 'double_faced_token', 'art_series', 'emblem')) DESC,
            released_at DESC, set_code, collector_number
        ) d
        WHERE cards.oracle_id = d.oracle_id AND cards.is_default_printing <> (cards.id = d.id)
        """;

    // Columns written by the import, in COPY order. The first must be the key.
    // JSON columns use EF's default (CLR) property names, which is how EF reads them back.
    private static readonly (string Name, NpgsqlDbType Type, Func<Card, object?> Value)[] Columns =
    [
        ("id", NpgsqlDbType.Uuid, c => c.Id),
        ("oracle_id", NpgsqlDbType.Uuid, c => c.OracleId),
        ("name", NpgsqlDbType.Text, c => c.Name),
        ("lang", NpgsqlDbType.Text, c => c.Lang),
        ("released_at", NpgsqlDbType.Date, c => c.ReleasedAt),
        ("layout", NpgsqlDbType.Text, c => c.Layout),
        ("mana_cost", NpgsqlDbType.Text, c => c.ManaCost),
        ("mana_value", NpgsqlDbType.Numeric, c => c.ManaValue),
        ("type_line", NpgsqlDbType.Text, c => c.TypeLine),
        ("oracle_text", NpgsqlDbType.Text, c => c.OracleText),
        ("power", NpgsqlDbType.Text, c => c.Power),
        ("toughness", NpgsqlDbType.Text, c => c.Toughness),
        ("loyalty", NpgsqlDbType.Text, c => c.Loyalty),
        ("colors", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.Colors),
        ("color_identity", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.ColorIdentity),
        ("keywords", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.Keywords),
        ("set_code", NpgsqlDbType.Text, c => c.SetCode),
        ("set_name", NpgsqlDbType.Text, c => c.SetName),
        ("set_type", NpgsqlDbType.Text, c => c.SetType),
        ("collector_number", NpgsqlDbType.Text, c => c.CollectorNumber),
        ("rarity", NpgsqlDbType.Text, c => c.Rarity),
        ("artist", NpgsqlDbType.Text, c => c.Artist),
        ("flavor_text", NpgsqlDbType.Text, c => c.FlavorText),
        ("legal_formats", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.LegalFormats),
        ("banned_formats", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.BannedFormats),
        ("restricted_formats", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.RestrictedFormats),
        ("images", NpgsqlDbType.Jsonb, c => c.Images is null ? null : JsonSerializer.Serialize(c.Images)),
        ("faces", NpgsqlDbType.Jsonb, c => JsonSerializer.Serialize(c.Faces)),
        ("full_art", NpgsqlDbType.Boolean, c => c.FullArt),
        ("promo", NpgsqlDbType.Boolean, c => c.Promo),
        ("digital", NpgsqlDbType.Boolean, c => c.Digital),
        ("oversized", NpgsqlDbType.Boolean, c => c.Oversized),
        ("finishes", NpgsqlDbType.Array | NpgsqlDbType.Text, c => c.Finishes),
        ("usd", NpgsqlDbType.Numeric, c => c.Usd),
        ("usd_foil", NpgsqlDbType.Numeric, c => c.UsdFoil),
        ("usd_etched", NpgsqlDbType.Numeric, c => c.UsdEtched),
        ("eur", NpgsqlDbType.Numeric, c => c.Eur),
        ("eur_foil", NpgsqlDbType.Numeric, c => c.EurFoil),
        ("tix", NpgsqlDbType.Numeric, c => c.Tix),
    ];
}
