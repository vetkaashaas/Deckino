using Deckino.Api.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Catalogue;

public static class CardEndpoints
{
    private const int PageSize = 60;
    private const int MaxPage = 1000; // keeps the OFFSET from overflowing
    private static readonly string[] ColorCodes = ["W", "U", "B", "R", "G"];

    public static void MapCardEndpoints(this WebApplication app)
    {
        app.MapGet("/api/cards", SearchAsync);
        app.MapGet("/api/cards/{id:guid}", GetAsync);
        app.MapGet("/api/sets", GetSetsAsync);
    }

    // Name search grouped by Oracle card: one result per card, showing its default printing
    // (or, when filtering by set, its printing in that set). Tokens and art cards only with extras=true.
    private static async Task<CardSearchResult> SearchAsync(
        DeckinoDbContext db, string? q, string? colors, string? type, string? set,
        bool extras = false, int page = 1, CancellationToken ct = default)
    {
        var name = q?.Trim() ?? "";
        var nameLike = EscapeLike(name);
        var typeLike = EscapeLike(type?.Trim() ?? "");
        var setCode = set?.Trim().ToLowerInvariant() ?? "";
        var wanted = (colors ?? "").ToUpperInvariant();
        var colorless = wanted.Contains('C');
        var wantedColors = ColorCodes.Where(c => wanted.Contains(c[0])).ToArray();
        var offset = (Math.Clamp(page, 1, MaxPage) - 1) * PageSize;

        var ids = await db.Database.SqlQuery<Guid>(
            $"""
             SELECT id AS "Value" FROM (
               SELECT DISTINCT ON (oracle_id) id, name FROM cards
               WHERE ({setCode} = '' AND is_default_printing OR set_code = {setCode})
                 AND ({name} = '' OR name ILIKE '%' || {nameLike} || '%' OR {name} <% name)
                 AND ({typeLike} = '' OR type_line ILIKE '%' || {typeLike} || '%')
                 AND colors @> {wantedColors}
                 AND (NOT {colorless} OR cardinality(colors) = 0)
                 AND ({extras} OR layout NOT IN ('token', 'double_faced_token', 'art_series', 'emblem'))
               ORDER BY oracle_id, is_missing_upstream, released_at DESC
             ) r
             ORDER BY name ILIKE {nameLike} || '%' DESC, word_similarity({name}, name) DESC, name, id
             LIMIT {PageSize + 1} OFFSET {offset}
             """).ToListAsync(ct);

        var pageIds = ids.Take(PageSize).ToList();
        var cards = await db.Cards.AsNoTracking().Where(c => pageIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        return new CardSearchResult(pageIds.Select(id => CardSummary.From(cards[id])).ToList(), ids.Count > PageSize);
    }

    private static async Task<Results<Ok<CardDetail>, NotFound>> GetAsync(Guid id, DeckinoDbContext db, CancellationToken ct)
    {
        var card = await db.Cards.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id, ct);
        if (card is null) return TypedResults.NotFound();

        var printings = await db.Cards
            .Where(c => c.OracleId == card.OracleId)
            .OrderByDescending(c => c.ReleasedAt).ThenBy(c => c.SetCode).ThenBy(c => c.CollectorNumber)
            .Select(c => new PrintingSummary(
                c.Id, c.SetCode, c.SetName, c.CollectorNumber, c.ReleasedAt, c.Lang, c.Usd, c.Eur, c.IsDefaultPrinting))
            .ToListAsync(ct);
        return TypedResults.Ok(CardDetail.From(card, printings));
    }

    private static Task<List<SetSummary>> GetSetsAsync(DeckinoDbContext db, CancellationToken ct) =>
        db.Cards
            .GroupBy(c => new { c.SetCode, c.SetName })
            .Select(g => new { g.Key.SetCode, g.Key.SetName, ReleasedAt = g.Max(c => c.ReleasedAt) })
            .OrderByDescending(s => s.ReleasedAt).ThenBy(s => s.SetName)
            .Select(s => new SetSummary(s.SetCode, s.SetName))
            .ToListAsync(ct);

    private static string EscapeLike(string value) =>
        value.Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_");
}

public record CardSearchResult(List<CardSummary> Cards, bool HasMore);

public record CardSummary(
    Guid Id, string Name, string? ManaCost, string? TypeLine, string SetCode, string SetName, string? Image,
    decimal? Usd, decimal? Eur)
{
    public static CardSummary From(Card c) => new(
        c.Id, c.Name, c.ManaCost, c.TypeLine, c.SetCode, c.SetName,
        (c.Images ?? c.Faces.FirstOrDefault()?.Images)?.Normal, c.Usd, c.Eur);
}

public record CardDetail(
    Guid Id, Guid OracleId, string Name, string? ManaCost, decimal ManaValue, string? TypeLine, string? OracleText,
    string? Power, string? Toughness, string? Loyalty, string? FlavorText, string[] Colors,
    string SetCode, string SetName, string CollectorNumber, string Rarity, string? Artist, DateOnly ReleasedAt,
    string Lang, string[] Finishes, List<string> Images, List<CardFaceDetail> Faces, CardPrices Prices,
    List<PrintingSummary> Printings)
{
    public static CardDetail From(Card c, List<PrintingSummary> printings) => new(
        c.Id, c.OracleId, c.Name, c.ManaCost, c.ManaValue, c.TypeLine, c.OracleText,
        c.Power, c.Toughness, c.Loyalty, c.FlavorText, c.Colors,
        c.SetCode, c.SetName, c.CollectorNumber, c.Rarity, c.Artist, c.ReleasedAt,
        c.Lang, c.Finishes,
        // One image, or one per face for double-faced cards.
        c.Images is { } images ? [images.Large] : c.Faces.Where(f => f.Images is not null).Select(f => f.Images!.Large).ToList(),
        c.Faces.Select(f => new CardFaceDetail(
            f.Name, f.ManaCost, f.TypeLine, f.OracleText, f.FlavorText, f.Power, f.Toughness, f.Loyalty)).ToList(),
        new CardPrices(c.Usd, c.UsdFoil, c.UsdEtched, c.Eur, c.EurFoil),
        printings);
}

public record CardFaceDetail(
    string Name, string? ManaCost, string? TypeLine, string? OracleText, string? FlavorText,
    string? Power, string? Toughness, string? Loyalty);

public record CardPrices(decimal? Usd, decimal? UsdFoil, decimal? UsdEtched, decimal? Eur, decimal? EurFoil);

public record PrintingSummary(
    Guid Id, string SetCode, string SetName, string CollectorNumber, DateOnly ReleasedAt, string Lang,
    decimal? Usd, decimal? Eur, bool IsDefault);

public record SetSummary(string Code, string Name);
