using System.Security.Claims;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Decks;

// The signed-in user's decks. Every query filters on the owner, so another user's deck is a 404, never a 403.
public static class DeckEndpoints
{
    // Paper formats, as Scryfall legality keys. "casual" has no format rules.
    public static readonly string[] Formats = ["standard", "pioneer", "modern", "legacy", "vintage", "pauper", "commander", "casual"];
    private static readonly string[] Finishes = ["nonfoil", "foil", "etched"];
    private const int MaxNameLength = 100;
    private const int MaxEntries = 500;
    private const int MaxCommanders = 2; // partners, backgrounds

    public static void MapDeckEndpoints(this WebApplication app)
    {
        var decks = app.MapGroup("/api/decks").RequireAuthorization();
        decks.MapGet("", ListAsync);
        decks.MapPost("", CreateAsync);
        decks.MapGet("/{id:guid}", GetAsync);
        decks.MapPut("/{id:guid}", UpdateAsync);
        decks.MapDelete("/{id:guid}", DeleteAsync);
        decks.MapPost("/legality", LegalityAsync);
        decks.MapPut("/{id:guid}/visibility", SetVisibilityAsync);
    }

    private static async Task<List<DeckSummary>> ListAsync(ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var decks = await db.Decks.AsNoTracking()
            .Where(d => d.OwnerId == ownerId)
            .OrderByDescending(d => d.UpdatedAt)
            .ToListAsync(ct);
        var cards = await LoadCardsAsync(db, decks.SelectMany(d => d.Cards.Commander.Concat(d.Cards.Mainboard)), ct);
        return decks.Select(d => DeckSummary.From(d, cards)).ToList();
    }

    private static async Task<Results<Created<DeckDetail>, ValidationProblem>> CreateAsync(
        SaveDeckRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var (cards, errors) = await ValidateAsync(request, db, ct);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);

        var now = DateTimeOffset.UtcNow;
        var deck = new Deck
        {
            OwnerId = OwnerId(user),
            Name = request.Name!.Trim(),
            Format = request.Format!,
            Cards = cards,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Decks.Add(deck);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/decks/{deck.Id}", await DetailAsync(deck, db, ct));
    }

    private static async Task<Results<Ok<DeckDetail>, NotFound>> GetAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var deck = await db.Decks.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id && d.OwnerId == ownerId, ct);
        return deck is null ? TypedResults.NotFound() : TypedResults.Ok(await DetailAsync(deck, db, ct));
    }

    // Replaces the whole deck. Two tabs editing the same deck: the last save wins.
    private static async Task<Results<Ok<DeckDetail>, NotFound, ValidationProblem>> UpdateAsync(
        Guid id, SaveDeckRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var deck = await db.Decks.FirstOrDefaultAsync(d => d.Id == id && d.OwnerId == ownerId, ct);
        if (deck is null) return TypedResults.NotFound();

        var (cards, errors) = await ValidateAsync(request, db, ct);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);

        deck.Name = request.Name!.Trim();
        deck.Format = request.Format!;
        deck.Cards = cards;
        deck.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(deck, db, ct));
    }

    private static async Task<Results<NoContent, NotFound>> DeleteAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var deleted = await db.Decks.Where(d => d.Id == id && d.OwnerId == ownerId).ExecuteDeleteAsync(ct);
        return deleted == 0 ? TypedResults.NotFound() : TypedResults.NoContent();
    }

    // Public or private, saved straight away (not part of the builder's unsaved changes).
    private static async Task<Results<Ok<DeckDetail>, NotFound>> SetVisibilityAsync(
        Guid id, VisibilityRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var deck = await db.Decks.FirstOrDefaultAsync(d => d.Id == id && d.OwnerId == ownerId, ct);
        if (deck is null) return TypedResults.NotFound();
        deck.IsPublic = request.IsPublic;
        deck.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(deck, db, ct));
    }

    // Legality warnings for a deck as it is in the builder, saved or not. The name doesn't matter here.
    private static async Task<Results<Ok<List<string>>, ValidationProblem>> LegalityAsync(
        SaveDeckRequest request, DeckinoDbContext db, CancellationToken ct)
    {
        var (cards, errors) = await ValidateAsync(request with { Name = "-" }, db, ct);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);
        var loaded = await LoadCardsAsync(db, cards.Commander.Concat(cards.Mainboard).Concat(cards.Sideboard), ct);
        return TypedResults.Ok(DeckLegality.Check(request.Format!, cards, loaded));
    }

    // The request comes from outside the trust boundary: every rule from the plan is checked here.
    private static async Task<(DeckCards Cards, Dictionary<string, string[]> Errors)> ValidateAsync(
        SaveDeckRequest request, DeckinoDbContext db, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > MaxNameLength) errors["name"] = [$"Use 1 to {MaxNameLength} characters."];
        if (!Formats.Contains(request.Format)) errors["format"] = ["Choose a format."];

        var sections = new (string Name, List<DeckEntryRequest?>? Entries)[]
        {
            ("commander", request.Cards?.Commander), ("mainboard", request.Cards?.Mainboard), ("sideboard", request.Cards?.Sideboard),
        };
        var problems = new List<string>();
        var entries = sections.SelectMany(s => s.Entries ?? []).ToList();
        if (entries.Count > MaxEntries) problems.Add($"A deck holds at most {MaxEntries} entries.");
        else if (entries.Any(e => e is null)) problems.Add("Every entry needs a card.");
        else
        {
            if ((request.Cards?.Commander?.Count ?? 0) > MaxCommanders) problems.Add($"A deck has at most {MaxCommanders} commanders.");
            if (entries.Any(e => e!.Quantity is < 1 or > 99)) problems.Add("Quantities must be between 1 and 99.");
            if (entries.Any(e => !Finishes.Contains(e!.Finish))) problems.Add("Finish must be nonfoil, foil or etched.");
            foreach (var (section, list) in sections)
            {
                if (list is not null && list.CountBy(e => (e!.ScryfallId, e.Finish)).Any(g => g.Value > 1))
                {
                    problems.Add($"The same card and finish appears twice in the {section}.");
                }
            }

            var ids = entries.Select(e => e!.ScryfallId).Distinct().ToList();
            var finishes = await db.Cards.Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Finishes, ct);
            foreach (var entry in entries)
            {
                if (!finishes.TryGetValue(entry!.ScryfallId, out var offered)) problems.Add($"Card {entry.ScryfallId} doesn't exist.");
                else if (Finishes.Contains(entry.Finish) && !offered.Contains(entry.Finish))
                {
                    problems.Add($"Card {entry.ScryfallId} isn't printed in {entry.Finish}.");
                }
            }
        }
        if (problems.Count > 0) errors["cards"] = problems.Distinct().ToArray();
        if (errors.Count > 0) return (new DeckCards(), errors);

        List<DeckEntry> ToEntries(List<DeckEntryRequest?>? list) =>
            (list ?? []).Select(e => new DeckEntry { ScryfallId = e!.ScryfallId, Quantity = e.Quantity, Finish = e.Finish! }).ToList();
        return (new DeckCards
        {
            Commander = ToEntries(request.Cards?.Commander),
            Mainboard = ToEntries(request.Cards?.Mainboard),
            Sideboard = ToEntries(request.Cards?.Sideboard),
        }, errors);
    }

    internal static async Task<DeckDetail> DetailAsync(Deck deck, DeckinoDbContext db, CancellationToken ct)
    {
        var cards = await LoadCardsAsync(db, deck.Cards.Commander.Concat(deck.Cards.Mainboard).Concat(deck.Cards.Sideboard), ct);
        List<DeckEntryDetail> Section(List<DeckEntry> entries) =>
            entries.Select(e => new DeckEntryDetail(e.ScryfallId, e.Quantity, e.Finish, DeckCard.From(cards[e.ScryfallId]))).ToList();
        return new DeckDetail(
            deck.Id, deck.Name, deck.Format, deck.IsPublic, deck.CreatedAt, deck.UpdatedAt,
            Section(deck.Cards.Commander), Section(deck.Cards.Mainboard), Section(deck.Cards.Sideboard));
    }

    internal static Task<Dictionary<Guid, Card>> LoadCardsAsync(DeckinoDbContext db, IEnumerable<DeckEntry> entries, CancellationToken ct)
    {
        var ids = entries.Select(e => e.ScryfallId).Distinct().ToList();
        return db.Cards.AsNoTracking().Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
    }

    // RequireAuthorization guarantees the cookie's user ID claim.
    private static Guid OwnerId(ClaimsPrincipal user) => Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
}

public record SaveDeckRequest(string? Name, string? Format, DeckCardsRequest? Cards);
public record DeckCardsRequest(List<DeckEntryRequest?>? Commander, List<DeckEntryRequest?>? Mainboard, List<DeckEntryRequest?>? Sideboard);
public record DeckEntryRequest(Guid ScryfallId, int Quantity, string? Finish);

public record VisibilityRequest(bool IsPublic);

public record DeckSummary(
    Guid Id, string Name, string Format, bool IsPublic, int CardCount, string[] ColorIdentity, string? Cover, DateTimeOffset UpdatedAt)
{
    // Cover and colours follow the deck page header (deckLook in Deckino.Web/src/decks/deck.ts).
    public static DeckSummary From(Deck deck, Dictionary<Guid, Card> cards)
    {
        var commanders = deck.Cards.Commander.Select(e => cards[e.ScryfallId]).ToList();
        var mainboard = deck.Cards.Mainboard.Select(e => cards[e.ScryfallId]).ToList();
        var cover = commanders.FirstOrDefault() ?? mainboard.FirstOrDefault(c => c.TypeLine?.Contains("Land") != true) ?? mainboard.FirstOrDefault();
        var identity = (commanders.Count > 0 ? commanders : mainboard).SelectMany(c => c.ColorIdentity).ToHashSet();
        return new DeckSummary(
            deck.Id, deck.Name, deck.Format, deck.IsPublic,
            deck.Cards.Commander.Concat(deck.Cards.Mainboard).Sum(e => e.Quantity),
            "WUBRG".Select(c => c.ToString()).Where(identity.Contains).ToArray(),
            cover?.FrontImages?.ArtCrop ?? cover?.FrontImages?.Normal,
            deck.UpdatedAt);
    }
}

public record DeckDetail(
    Guid Id, string Name, string Format, bool IsPublic, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
    List<DeckEntryDetail> Commander, List<DeckEntryDetail> Mainboard, List<DeckEntryDetail> Sideboard);

public record DeckEntryDetail(Guid ScryfallId, int Quantity, string Finish, DeckCard Card);

// What the deck page shows for a printing. The web app builds the same shape from CardDetail for cards added in the page.
public record DeckCard(
    Guid Id, Guid OracleId, string Name, string? ManaCost, decimal ManaValue, string? TypeLine, string[] ColorIdentity,
    string SetCode, string SetName, string CollectorNumber, string? Image, string? ArtCrop, string[] Finishes, CardPrices Prices)
{
    public static DeckCard From(Card c) => new(
        c.Id, c.OracleId, c.Name, c.ManaCost ?? c.Faces.FirstOrDefault()?.ManaCost, c.ManaValue, c.TypeLine, c.ColorIdentity,
        c.SetCode, c.SetName, c.CollectorNumber, c.FrontImages?.Normal, c.FrontImages?.ArtCrop, c.Finishes,
        new CardPrices(c.Usd, c.UsdFoil, c.UsdEtched, c.Eur, c.EurFoil));
}
