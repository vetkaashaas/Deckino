using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Decks;

// Public decks, for anyone: search, and a deck's page. A private deck is a 404, the same as one that doesn't exist.
// Owners appear by username only; email addresses never leave the account endpoints.
public static class PublicDeckEndpoints
{
    private const int PageSize = 24;
    private const int MaxPage = 1000;

    public static void MapPublicDeckEndpoints(this WebApplication app)
    {
        app.MapGet("/api/public/decks", SearchAsync);
        app.MapGet("/api/public/decks/{id:guid}", GetAsync);
    }

    // Name search (ILIKE, served by the trigram index on decks.name) and a format filter, newest updated first.
    private static async Task<PublicDeckSearchResult> SearchAsync(
        DeckinoDbContext db, string? q, string? format, int page = 1, CancellationToken ct = default)
    {
        var pattern = $"%{CardEndpoints.EscapeLike(q?.Trim() ?? "")}%";
        var formatKey = format?.Trim().ToLowerInvariant() ?? "";
        var found = await db.Decks.AsNoTracking()
            .Where(d => d.IsPublic)
            .Where(d => formatKey == "" || d.Format == formatKey)
            .Where(d => EF.Functions.ILike(d.Name, pattern, @"\"))
            .Join(db.Users, d => d.OwnerId, u => u.Id, (d, u) => new { Deck = d, Owner = u.UserName! })
            .OrderByDescending(f => f.Deck.UpdatedAt).ThenBy(f => f.Deck.Id)
            .Skip((Math.Clamp(page, 1, MaxPage) - 1) * PageSize)
            .Take(PageSize + 1)
            .ToListAsync(ct);

        var shown = found.Take(PageSize).ToList();
        var cards = await DeckEndpoints.LoadCardsAsync(db, shown.SelectMany(f => f.Deck.Cards.Commander.Concat(f.Deck.Cards.Mainboard)), ct);
        return new PublicDeckSearchResult(
            shown.Select(f => new PublicDeckSummary(DeckSummary.From(f.Deck, cards), f.Owner)).ToList(),
            found.Count > PageSize);
    }

    private static async Task<Results<Ok<PublicDeck>, NotFound>> GetAsync(Guid id, DeckinoDbContext db, CancellationToken ct)
    {
        var found = await FindAsync(db, id, ct);
        if (found is null) return TypedResults.NotFound();
        var (deck, owner) = found.Value;
        var detail = await DeckEndpoints.DetailAsync(deck, db, ct);
        var cards = await DeckEndpoints.LoadCardsAsync(db, deck.Cards.Commander.Concat(deck.Cards.Mainboard).Concat(deck.Cards.Sideboard), ct);
        return TypedResults.Ok(new PublicDeck(detail, owner, DeckLegality.Check(deck.Format, deck.Cards, cards)));
    }

    // A public deck and its owner's username, or null.
    internal static async Task<(Deck Deck, string Owner)?> FindAsync(DeckinoDbContext db, Guid id, CancellationToken ct)
    {
        var found = await db.Decks.AsNoTracking()
            .Where(d => d.Id == id && d.IsPublic)
            .Join(db.Users, d => d.OwnerId, u => u.Id, (d, u) => new { Deck = d, Owner = u.UserName! })
            .FirstOrDefaultAsync(ct);
        return found is null ? null : (found.Deck, found.Owner);
    }
}

public record PublicDeckSearchResult(List<PublicDeckSummary> Decks, bool HasMore);
public record PublicDeckSummary(DeckSummary Deck, string Owner);
public record PublicDeck(DeckDetail Deck, string Owner, List<string> Legality);
