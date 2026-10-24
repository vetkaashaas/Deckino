using System.Security.Claims;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Prices;

// A printing's prices from one day on, in their own currencies (never converted): a row only when they changed, so a
// day without one has the prices of the row before it. CatalogueSync writes them and keeps 90 days, plus the row
// before those that the window starts with.
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
    // ponytail: a flat floor keeps bulk cards' big percentages out; per rarity or by sales volume if junk gets through.
    private const decimal MarketFloor = 2m;

    public static void MapPriceEndpoints(this WebApplication app)
    {
        app.MapGet("/api/cards/{id:guid}/prices", HistoryAsync);
        app.MapGet("/api/collection/prices", CollectionAsync).RequireAuthorization();
        app.MapGet("/api/prices/movers", MarketAsync);
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

    // One point per day for the last 90 days, oldest first, from the first day the printing had a price: each day has
    // the prices of the latest change on or before it, and today has today's. Days with no price at all are left out.
    private static async Task<List<PricePoint>> HistoryAsync(Guid id, DeckinoDbContext db, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var from = today.AddDays(-HistoryDays);
        var changes = await db.CardPriceSnapshots.AsNoTracking()
            .Where(s => s.ScryfallId == id && s.Provider == Provider && s.Date > from)
            .OrderBy(s => s.Date)
            .Select(s => new PricePoint(s.Date, s.Usd, s.UsdFoil, s.UsdEtched, s.Eur, s.EurFoil))
            .ToListAsync(ct);
        var before = await db.CardPriceSnapshots.AsNoTracking()
            .Where(s => s.ScryfallId == id && s.Provider == Provider && s.Date <= from)
            .OrderByDescending(s => s.Date)
            .Select(s => new PricePoint(from.AddDays(1), s.Usd, s.UsdFoil, s.UsdEtched, s.Eur, s.EurFoil))
            .FirstOrDefaultAsync(ct);
        var now = await db.Cards.AsNoTracking()
            .Where(c => c.Id == id)
            .Select(c => new PricePoint(today, c.Price.Usd, c.Price.UsdFoil, c.Price.UsdEtched, c.Price.Eur, c.Price.EurFoil))
            .FirstOrDefaultAsync(ct);

        var points = (before is null ? changes : changes.Prepend(before))
            .Where(p => p.Date < today)
            .Concat(now is null ? [] : [now])
            .ToList();
        var days = new List<PricePoint>();
        for (var i = 0; i < points.Count; i++)
        {
            var until = i + 1 < points.Count ? points[i + 1].Date : today.AddDays(1);
            if (points[i] is { Usd: null, UsdFoil: null, UsdEtched: null, Eur: null, EurFoil: null }) continue;
            for (var day = points[i].Date; day < until; day = day.AddDays(1)) days.Add(points[i] with { Date = day });
        }
        return days;
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

        // Each printing's price a week ago: its latest change on or before then.
        var weekAgo = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-7);
        var then = await db.CardPriceSnapshots.AsNoTracking()
            .Where(s => ids.Contains(s.ScryfallId) && s.Provider == Provider && s.Date <= weekAgo)
            .GroupBy(s => s.ScryfallId)
            .Select(g => g.OrderByDescending(s => s.Date).First())
            .ToDictionaryAsync(s => s.ScryfallId, ct);

        decimal value = 0, change = 0;
        var movers = new List<PriceMover>();
        foreach (var o in owned)
        {
            var c = cards[o.ScryfallId];
            var now = Price(o.Finish, money, c.Price.Usd, c.Price.UsdFoil, c.Price.UsdEtched, c.Price.Eur, c.Price.EurFoil);
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

    // The whole market's biggest moves this week, the same for everyone, so worked out once a day per currency
    // (as CommanderOfTheDay): requests that arrive while it loads wait for the same load.
    private static readonly Lock MarketGate = new();
    private static readonly Dictionary<string, (DateOnly Day, Task<MarketMovers> Movers)> Market = [];

    private static Task<MarketMovers> MarketAsync(IServiceScopeFactory scopes, string? currency, CancellationToken ct)
    {
        var money = currency == "eur" ? "eur" : "usd";
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        Task<MarketMovers> load;
        lock (MarketGate)
        {
            // A failed load, or nothing found (no price history from a week ago yet), is tried again by the next request.
            if (!Market.TryGetValue(money, out var m) || m.Day != today || m.Movers.IsFaulted
                || m.Movers is { IsCompletedSuccessfully: true, Result: { Rising.Count: 0, Falling.Count: 0 } })
                Market[money] = m = (today, LoadMarketAsync(scopes, money, today));
            load = m.Movers;
        }
        return load.WaitAsync(ct);
    }

    // Nonfoil prices now against each card's latest change on or before a week ago, for cards worth MarketFloor or more
    // on both days. Only each card's default printing: promos, Secret Lairs and foreign printings sell too rarely for
    // their prices to mean much. Percent ranks them, so a $2 card that doubled beats a $500 one that rose $20.
    private static async Task<MarketMovers> LoadMarketAsync(IServiceScopeFactory scopes, string money, DateOnly today)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<DeckinoDbContext>();
        var weekAgo = today.AddDays(-7);
        // No history from a week ago yet (a new database): skip the scan below, which every request retries until then.
        if (!await db.CardPriceSnapshots.AnyAsync(s => s.Provider == Provider && s.Date <= weekAgo))
            return new MarketMovers(money, [], []);
        var euros = money == "eur";
        var rows = (await db.Cards.AsNoTracking()
            .Where(c => c.IsDefaultPrinting)
            .Select(c => new
            {
                c.Id,
                Now = euros ? c.Price.Eur : c.Price.Usd,
                Before = db.CardPriceSnapshots
                    .Where(s => s.ScryfallId == c.Id && s.Provider == Provider && s.Date <= weekAgo)
                    .OrderByDescending(s => s.Date)
                    .Select(s => euros ? s.Eur : s.Usd)
                    .FirstOrDefault(),
            })
            .Where(r => r.Now >= MarketFloor)
            .ToListAsync())
            // Here, not in SQL: there EF would repeat the history lookup once per use of Before.
            .Where(r => r.Before >= MarketFloor && r.Now != r.Before);
        var moved = rows
            .Select(r => (r.Id, Before: r.Before!.Value, Now: r.Now!.Value,
                Percent: Math.Round((r.Now!.Value - r.Before!.Value) / r.Before!.Value * 100, 1)))
            .ToList();
        var rising = moved.Where(r => r.Percent > 0).OrderByDescending(r => r.Percent).Take(MoverCount).ToList();
        var falling = moved.Where(r => r.Percent < 0).OrderBy(r => r.Percent).Take(MoverCount).ToList();

        var ids = rising.Concat(falling).Select(r => r.Id).ToList();
        var cards = await db.Cards.AsNoTracking().Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id);
        PriceMover Mover((Guid Id, decimal Before, decimal Now, decimal Percent) r) =>
            new(DeckCard.From(cards[r.Id]), "nonfoil", 1, r.Before, r.Now, r.Now - r.Before, r.Percent);
        return new MarketMovers(money, rising.Select(Mover).ToList(), falling.Select(Mover).ToList());
    }
}

public record PricePoint(DateOnly Date, decimal? Usd, decimal? UsdFoil, decimal? UsdEtched, decimal? Eur, decimal? EurFoil);
public record CollectionPrices(string Currency, decimal Value, decimal WeekChange, List<PriceMover> Movers);
public record MarketMovers(string Currency, List<PriceMover> Rising, List<PriceMover> Falling);
public record PriceMover(DeckCard Card, string Finish, int Count, decimal Before, decimal Now, decimal Change, decimal Percent);
