using System.Security.Claims;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Wishlist;

// A card printing the user wants, and how many. One row per printing per user.
public class WantedCard
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public Guid ScryfallId { get; set; }
    public int Quantity { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

// The signed-in user's wishlist, and how a deck compares with the cards in their binders.
public static class WishlistEndpoints
{
    private const int MaxQuantity = 99;
    private const int MaxEntries = 2_000;

    public static void MapWishlistEndpoints(this WebApplication app)
    {
        var wishlist = app.MapGroup("/api/wishlist").RequireAuthorization();
        wishlist.MapGet("", ListAsync);
        wishlist.MapPost("", AddAsync);
        wishlist.MapPut("/{id:guid}", UpdateAsync);
        wishlist.MapDelete("/{id:guid}", DeleteAsync);

        var decks = app.MapGroup("/api/decks/{id:guid}").RequireAuthorization();
        decks.MapGet("/collection", CompareAsync);
        decks.MapPost("/collection/wishlist", AddMissingAsync);
    }

    private static Task<List<WantedCardDetail>> ListAsync(ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct) =>
        DetailAsync(OwnerId(user), db, ct);

    // Adds to the entry for that printing, or starts one.
    private static async Task<Results<Ok<List<WantedCardDetail>>, ValidationProblem>> AddAsync(
        WantedCardRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var quantity = request.Quantity ?? 1;
        var errors = await ValidateAsync(request.ScryfallId, quantity, db, ct);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);

        var existing = await db.WantedCards.FirstOrDefaultAsync(w => w.OwnerId == ownerId && w.ScryfallId == request.ScryfallId, ct);
        if (existing is null && await db.WantedCards.CountAsync(w => w.OwnerId == ownerId, ct) >= MaxEntries) return TooMany();
        var now = DateTimeOffset.UtcNow;
        if (existing is null)
        {
            db.WantedCards.Add(new WantedCard { OwnerId = ownerId, ScryfallId = request.ScryfallId!.Value, Quantity = quantity, CreatedAt = now, UpdatedAt = now });
        }
        else
        {
            existing.Quantity = Math.Min(MaxQuantity, existing.Quantity + quantity);
            existing.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(ownerId, db, ct));
    }

    // Changes the quantity and/or the printing. Choosing a printing already on the list merges the two entries.
    private static async Task<Results<Ok<List<WantedCardDetail>>, NotFound, ValidationProblem>> UpdateAsync(
        Guid id, WantedCardRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var entry = await db.WantedCards.FirstOrDefaultAsync(w => w.Id == id && w.OwnerId == ownerId, ct);
        if (entry is null) return TypedResults.NotFound();
        var scryfallId = request.ScryfallId ?? entry.ScryfallId;
        var quantity = request.Quantity ?? entry.Quantity;
        var errors = await ValidateAsync(scryfallId, quantity, db, ct);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);

        var now = DateTimeOffset.UtcNow;
        var other = scryfallId == entry.ScryfallId
            ? null
            : await db.WantedCards.FirstOrDefaultAsync(w => w.OwnerId == ownerId && w.ScryfallId == scryfallId, ct);
        if (other is not null)
        {
            other.Quantity = Math.Min(MaxQuantity, other.Quantity + quantity);
            other.UpdatedAt = now;
            db.WantedCards.Remove(entry);
        }
        else
        {
            entry.ScryfallId = scryfallId;
            entry.Quantity = quantity;
            entry.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(ownerId, db, ct));
    }

    private static async Task<Results<Ok<List<WantedCardDetail>>, NotFound>> DeleteAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var deleted = await db.WantedCards.Where(w => w.Id == id && w.OwnerId == ownerId).ExecuteDeleteAsync(ct);
        return deleted == 0 ? TypedResults.NotFound() : TypedResults.Ok(await DetailAsync(ownerId, db, ct));
    }

    private static async Task<Results<Ok<DeckComparison>, NotFound>> CompareAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var comparison = await ComparisonAsync(id, OwnerId(user), db, ct);
        return comparison is null ? TypedResults.NotFound() : TypedResults.Ok(comparison);
    }

    // Puts the deck's missing cards on the wishlist: each missing printing wanted at least as many times as it's
    // missing. Running it twice changes nothing; decks are compared one at a time, never added up.
    private static async Task<Results<Ok<AddedToWishlist>, NotFound, ValidationProblem>> AddMissingAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var comparison = await ComparisonAsync(id, ownerId, db, ct);
        if (comparison is null) return TypedResults.NotFound();

        var missing = comparison.Cards.SelectMany(c => c.MissingPrintings)
            .GroupBy(m => m.ScryfallId).ToDictionary(g => g.Key, g => g.Sum(m => m.Quantity));
        var ids = missing.Keys.ToList();
        var existing = await db.WantedCards.Where(w => w.OwnerId == ownerId && ids.Contains(w.ScryfallId)).ToDictionaryAsync(w => w.ScryfallId, ct);
        var total = await db.WantedCards.CountAsync(w => w.OwnerId == ownerId, ct);
        if (total + ids.Count(i => !existing.ContainsKey(i)) > MaxEntries) return TooMany();

        var now = DateTimeOffset.UtcNow;
        var added = 0;
        foreach (var (scryfallId, quantity) in missing)
        {
            var wanted = Math.Min(MaxQuantity, quantity);
            if (existing.TryGetValue(scryfallId, out var entry))
            {
                if (entry.Quantity >= wanted) continue;
                added += wanted - entry.Quantity;
                entry.Quantity = wanted;
                entry.UpdatedAt = now;
            }
            else
            {
                db.WantedCards.Add(new WantedCard { OwnerId = ownerId, ScryfallId = scryfallId, Quantity = wanted, CreatedAt = now, UpdatedAt = now });
                added += wanted;
            }
        }
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(new AddedToWishlist(added));
    }

    // Owned means any printing of the same Oracle card in any of the user's binders (selling ones too).
    // Commander decks leave out the sideboard, as the legality checks do: there it's a maybeboard.
    private static async Task<DeckComparison?> ComparisonAsync(Guid deckId, Guid ownerId, DeckinoDbContext db, CancellationToken ct)
    {
        var deck = await db.Decks.AsNoTracking().FirstOrDefaultAsync(d => d.Id == deckId && d.OwnerId == ownerId, ct);
        if (deck is null) return null;
        var entries = deck.Cards.Commander.Concat(deck.Cards.Mainboard)
            .Concat(deck.Format == "commander" ? [] : deck.Cards.Sideboard).ToList();
        var ids = entries.Select(e => e.ScryfallId).Distinct().ToList();
        var cards = await db.Cards.AsNoTracking().Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        var oracleIds = cards.Values.Select(c => c.OracleId).Distinct().ToList();

        var owned = await db.BinderCards
            .Where(b => db.Binders.Any(x => x.Id == b.BinderId && x.OwnerId == ownerId))
            .Join(db.Cards, b => b.ScryfallId, c => c.Id, (b, c) => c.OracleId)
            .Where(o => oracleIds.Contains(o))
            .GroupBy(o => o)
            .Select(g => new { OracleId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.OracleId, g => g.Count, ct);

        var result = entries
            .GroupBy(e => cards[e.ScryfallId].OracleId)
            .Select(g =>
            {
                var needed = g.Sum(e => e.Quantity);
                var have = Math.Min(needed, owned.GetValueOrDefault(g.Key));
                // Owned copies cover the deck's entries in order; what's left is missing, in the printing the deck chose.
                var budget = have;
                var missing = new List<MissingPrinting>();
                foreach (var entry in g)
                {
                    var covered = Math.Min(budget, entry.Quantity);
                    budget -= covered;
                    if (entry.Quantity > covered) missing.Add(new MissingPrinting(entry.ScryfallId, entry.Quantity - covered));
                }
                return new ComparisonCard(g.Key, cards[g.First().ScryfallId].Name, needed, have, needed - have, missing, DeckCard.From(cards[g.First().ScryfallId]));
            })
            .OrderByDescending(c => c.Missing > 0).ThenBy(c => c.Name)
            .ToList();
        return new DeckComparison(result.Sum(c => c.Owned), result.Sum(c => c.Missing), result);
    }

    private static async Task<Dictionary<string, string[]>> ValidateAsync(Guid? scryfallId, int quantity, DeckinoDbContext db, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (quantity is < 1 or > MaxQuantity) errors["quantity"] = [$"Want 1 to {MaxQuantity} copies."];
        if (scryfallId is null || !await db.Cards.AnyAsync(c => c.Id == scryfallId, ct)) errors["scryfallId"] = ["That card doesn't exist."];
        return errors;
    }

    private static async Task<List<WantedCardDetail>> DetailAsync(Guid ownerId, DeckinoDbContext db, CancellationToken ct)
    {
        var rows = await db.WantedCards.AsNoTracking()
            .Where(w => w.OwnerId == ownerId)
            .Join(db.Cards, w => w.ScryfallId, c => c.Id, (w, c) => new { Wanted = w, Card = c })
            .OrderBy(x => x.Card.Name).ThenBy(x => x.Wanted.CreatedAt)
            .ToListAsync(ct);
        return rows.Select(r => new WantedCardDetail(r.Wanted.Id, r.Wanted.ScryfallId, r.Wanted.Quantity, DeckCard.From(r.Card))).ToList();
    }

    private static ValidationProblem TooMany() =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["scryfallId"] = [$"A wishlist holds at most {MaxEntries} cards."] });

    // RequireAuthorization guarantees the cookie's user ID claim.
    private static Guid OwnerId(ClaimsPrincipal user) => Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
}

public record WantedCardRequest(Guid? ScryfallId, int? Quantity);
public record WantedCardDetail(Guid Id, Guid ScryfallId, int Quantity, DeckCard Card);
public record DeckComparison(int Owned, int Missing, List<ComparisonCard> Cards);
public record ComparisonCard(Guid OracleId, string Name, int Needed, int Owned, int Missing, List<MissingPrinting> MissingPrintings, DeckCard Card);
public record MissingPrinting(Guid ScryfallId, int Quantity);
public record AddedToWishlist(int Added);
