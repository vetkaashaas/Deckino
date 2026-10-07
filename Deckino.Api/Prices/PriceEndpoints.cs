using System.Security.Claims;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Prices;

// One printing's prices on one day, in their own currencies (never converted). Rolling 90 days.
public class CardPriceSnapshot
{
    public Guid ScryfallId { get; set; }
    public required string Provider { get; set; } // "scryfall": TCGplayer (USD), Cardmarket (EUR), MTGO (TIX)
    public DateOnly Date { get; set; }
    public decimal? Usd { get; set; }
    public decimal? UsdFoil { get; set; }
    public decimal? UsdEtched { get; set; }
    public decimal? Eur { get; set; }
    public decimal? EurFoil { get; set; }
    public decimal? Tix { get; set; }
}

public static class PriceEndpoints
{
    public const string Provider = "scryfall";
    public const int HistoryDays = 90;
    private const int MoverCount = 5;

    public static void MapPriceEndpoints(this WebApplication app)
    {
        app.MapGet("/api/cards/{id:guid}/prices", HistoryAsync);
        app.MapGet("/api/collection/prices", CollectionAsync).RequireAuthorization();
    }

    // The current price of a printing in a finish and currency. Every value Deckino shows goes through here (and
    // entryPrice in Deckino.Web/src/decks/deck.ts, its browser twin), so another provider plugs in at one place.
    // Scryfall has no EUR price for etched cards.
    public static decimal? Price(string finish, string currency, decimal? usd, decimal? usdFoil, decimal? usdEtched, decimal? eur, decimal? eurFoil) =>
        (currency, finish) switch
        {
            ("eur", "nonfoil") => eur,
            ("eur", "foil") => eurFoil,
            ("eur", _) => null,
            (_, "nonfoil") => usd,
            (_, "foil") => usdFoil,
            _ => usdEtched,
        };

    // Today's prices for every printing that has one, then drop days past the window. Run after each catalogue
    // check: a re-run on the same day overwrites that day's row with the latest prices.
    public static async Task SnapshotAsync(DeckinoDbContext db, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var oldest = today.AddDays(-HistoryDays);
        db.Database.SetCommandTimeout(TimeSpan.FromMinutes(5));
        await db.Database.ExecuteSqlAsync(
            $"""
             INSERT INTO card_price_snapshots (scryfall_id, provider, date, usd, usd_foil, usd_etched, eur, eur_foil, tix)
             SELECT id, {Provider}, {today}, usd, usd_foil, usd_etched, eur, eur_foil, tix FROM cards
             WHERE COALESCE(usd, usd_foil, usd_etched, eur, eur_foil, tix) IS NOT NULL
             ON CONFLICT (scryfall_id, provider, date) DO UPDATE SET
               usd = excluded.usd, usd_foil = excluded.usd_foil, usd_etched = excluded.usd_etched,
               eur = excluded.eur, eur_foil = excluded.eur_foil, tix = excluded.tix
             """, ct);
        await db.Database.ExecuteSqlAsync($"DELETE FROM card_price_snapshots WHERE date <= {oldest}", ct);
    }

    public static Task<bool> HasSnapshotTodayAsync(DeckinoDbContext db, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        return db.CardPriceSnapshots.AnyAsync(s => s.Date == today, ct);
    }

    private static async Task<List<PricePoint>> HistoryAsync(Guid id, DeckinoDbContext db, CancellationToken ct)
    {
        var from = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-HistoryDays);
        return await db.CardPriceSnapshots.AsNoTracking()
            .Where(s => s.ScryfallId == id && s.Provider == Provider && s.Date > from)
            .OrderBy(s => s.Date)
            .Select(s => new PricePoint(s.Date, s.Usd, s.UsdFoil, s.UsdEtched, s.Eur, s.EurFoil))
            .ToListAsync(ct);
    }

    // The value of every card in the user's binders now and a week ago, and the cards that moved it most.
    // A card counts in the change only when it has a price on both days.
    private static async Task<CollectionPrices> CollectionAsync(
        ClaimsPrincipal user, DeckinoDbContext db, string? currency, CancellationToken ct)
    {
        var ownerId = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var money = currency == "eur" ? "eur" : "usd";
        var owned = await db.BinderCards
            .Where(c => db.Binders.Any(b => b.Id == c.BinderId && b.OwnerId == ownerId))
            .GroupBy(c => new { c.ScryfallId, c.Finish })
            .Select(g => new { g.Key.ScryfallId, g.Key.Finish, Count = g.Count() })
            .ToListAsync(ct);
        var ids = owned.Select(o => o.ScryfallId).Distinct().ToList();
        var cards = await db.Cards.AsNoTracking().Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);

        // Each printing's price a week ago: its latest snapshot from 7 to 13 days back.
        var weekAgo = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-7);
        var then = (await db.CardPriceSnapshots.AsNoTracking()
                .Where(s => ids.Contains(s.ScryfallId) && s.Provider == Provider && s.Date <= weekAgo && s.Date > weekAgo.AddDays(-7))
                .ToListAsync(ct))
            .GroupBy(s => s.ScryfallId)
            .ToDictionary(g => g.Key, g => g.MaxBy(s => s.Date)!);

        decimal value = 0, change = 0;
        var movers = new List<PriceMover>();
        foreach (var o in owned)
        {
            var c = cards[o.ScryfallId];
            var now = Price(o.Finish, money, c.Usd, c.UsdFoil, c.UsdEtched, c.Eur, c.EurFoil);
            if (now is null) continue;
            value += now.Value * o.Count;
            if (!then.TryGetValue(o.ScryfallId, out var s)) continue;
            var before = Price(o.Finish, money, s.Usd, s.UsdFoil, s.UsdEtched, s.Eur, s.EurFoil);
            if (before is null or 0 || before == now) continue;
            change += (now.Value - before.Value) * o.Count;
            movers.Add(new PriceMover(DeckCard.From(c), o.Finish, o.Count, before.Value, now.Value,
                (now.Value - before.Value) * o.Count, Math.Round((now.Value - before.Value) / before.Value * 100, 1)));
        }
        return new CollectionPrices(money, value, change,
            movers.OrderByDescending(m => Math.Abs(m.Change)).ThenBy(m => m.Card.Name).Take(MoverCount).ToList());
    }
}

public record PricePoint(DateOnly Date, decimal? Usd, decimal? UsdFoil, decimal? UsdEtched, decimal? Eur, decimal? EurFoil);
public record CollectionPrices(string Currency, decimal Value, decimal WeekChange, List<PriceMover> Movers);
public record PriceMover(DeckCard Card, string Finish, int Count, decimal Before, decimal Now, decimal Change, decimal Percent);
