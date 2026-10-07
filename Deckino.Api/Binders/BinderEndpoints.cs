using System.Security.Claims;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Binders;

// The signed-in user's binders and their physical cards. Every query filters on the owner, so another user's
// binder is a 404. GET /api/public/binders/{id} is the one anonymous read, and only for public binders.
public static class BinderEndpoints
{
    public static readonly string[] Conditions = ["NM", "LP", "MP", "HP", "DMG"];
    public static readonly string[] Languages = ["en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "ph"];
    private static readonly string[] Finishes = ["nonfoil", "foil", "etched"];
    private const int MaxNameLength = 100;
    private const int MaxNotesLength = 500;
    private const int MaxCopies = 100; // per "add N copies"
    private const int MaxCardsPerBinder = 10_000;

    public static void MapBinderEndpoints(this WebApplication app)
    {
        var binders = app.MapGroup("/api/binders").RequireAuthorization();
        binders.MapGet("", ListAsync);
        binders.MapPost("", CreateAsync);
        binders.MapPost("/import", ImportAsync);
        binders.MapGet("/{id:guid}", GetAsync);
        binders.MapPut("/{id:guid}", UpdateAsync);
        binders.MapDelete("/{id:guid}", DeleteAsync);
        binders.MapPost("/{id:guid}/cards", AddCardsAsync);
        binders.MapPut("/{id:guid}/cards/{cardId:guid}", UpdateCardAsync);
        binders.MapDelete("/{id:guid}/cards/{cardId:guid}", DeleteCardAsync);
        binders.MapPost("/{id:guid}/cards/move", MoveCardsAsync);

        app.MapGet("/api/public/binders/{id:guid}", GetPublicAsync);
    }

    private static async Task<List<BinderSummary>> ListAsync(ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var binders = await db.Binders.AsNoTracking()
            .Where(b => b.OwnerId == ownerId)
            .OrderByDescending(b => b.UpdatedAt)
            .Select(b => new
            {
                Binder = b,
                Count = db.BinderCards.Count(c => c.BinderId == b.Id),
                Cover = db.BinderCards.Where(c => c.BinderId == b.Id).OrderBy(c => c.CreatedAt).Select(c => (Guid?)c.ScryfallId).FirstOrDefault(),
            })
            .ToListAsync(ct);
        var coverIds = binders.Where(b => b.Cover is not null).Select(b => b.Cover!.Value).Distinct().ToList();
        var covers = await db.Cards.AsNoTracking().Where(c => coverIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        return binders.Select(b =>
        {
            var cover = b.Cover is { } coverId ? covers[coverId].FrontImages : null;
            return new BinderSummary(
                b.Binder.Id, b.Binder.Name, b.Binder.IsPublic, b.Binder.IsSelling, b.Count,
                cover?.ArtCrop ?? cover?.Normal, b.Binder.UpdatedAt);
        }).ToList();
    }

    private static async Task<Results<Created<BinderDetail>, ValidationProblem>> CreateAsync(
        SaveBinderRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > MaxNameLength) return NameError();

        var now = DateTimeOffset.UtcNow;
        var binder = new Binder
        {
            OwnerId = OwnerId(user),
            Name = name,
            IsPublic = request.IsPublic ?? false,
            IsSelling = request.IsSelling ?? false,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Binders.Add(binder);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/binders/{binder.Id}", await DetailAsync(binder, db, ct));
    }

    // A new binder with many cards at once (a reviewed import), all or nothing.
    private static async Task<Results<Created<BinderDetail>, ValidationProblem>> ImportAsync(
        ImportBinderRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > MaxNameLength) return NameError();
        var cards = request.Cards ?? [];
        if (cards.Count == 0 || cards.Any(c => c?.Card is null)) return CardsError("Choose the cards to import.");
        if (cards.Any(c => c!.Copies is < 1 or > 999)) return CardsError("Each line needs 1 to 999 copies.");
        if (cards.Sum(c => c!.Copies) > MaxCardsPerBinder) return CardsError($"A binder holds at most {MaxCardsPerBinder} cards.");

        var ids = cards.Select(c => c!.Card!.ScryfallId).Distinct().ToList();
        var finishes = await db.Cards.Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Finishes, ct);
        var problems = cards.Select((c, i) => (Line: i + 1, Error: CheckCard(c!.Card!, finishes))).Where(p => p.Error is not null)
            .Select(p => $"Card {p.Line}: {p.Error}").Take(20).ToArray();
        if (problems.Length > 0) return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["cards"] = problems });

        var now = DateTimeOffset.UtcNow;
        var binder = new Binder { OwnerId = OwnerId(user), Name = name, CreatedAt = now, UpdatedAt = now };
        db.Binders.Add(binder);
        foreach (var item in cards)
        {
            for (var i = 0; i < item!.Copies; i++)
            {
                var card = new BinderCard { BinderId = binder.Id, Condition = "", Finish = "", Language = "", CreatedAt = now, UpdatedAt = now };
                Apply(card, item.Card!);
                db.BinderCards.Add(card);
            }
        }
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/binders/{binder.Id}", await DetailAsync(binder, db, ct));
    }

    private static ValidationProblem CardsError(string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["cards"] = [message] });

    // The same rules as ValidateCardAsync, against finishes already loaded.
    private static string? CheckCard(BinderCardRequest card, Dictionary<Guid, string[]> finishes)
    {
        if (!finishes.TryGetValue(card.ScryfallId, out var offered)) return "that card doesn't exist.";
        if (!Finishes.Contains(card.Finish) || !offered.Contains(card.Finish)) return "this printing doesn't come in that finish.";
        if (!Conditions.Contains(card.Condition)) return "choose a condition.";
        if (!Languages.Contains(card.Language)) return "choose a language.";
        if (card.Notes?.Trim().Length > MaxNotesLength) return $"notes use at most {MaxNotesLength} characters.";
        return null;
    }

    private static async Task<Results<Ok<BinderDetail>, NotFound>> GetAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var binder = await FindAsync(db, id, user, ct);
        return binder is null ? TypedResults.NotFound() : TypedResults.Ok(await DetailAsync(binder, db, ct));
    }

    // Name, public and selling. Fields left out of the request keep their value.
    private static async Task<Results<Ok<BinderDetail>, NotFound, ValidationProblem>> UpdateAsync(
        Guid id, SaveBinderRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var binder = await FindAsync(db, id, user, ct);
        if (binder is null) return TypedResults.NotFound();
        if (request.Name is not null)
        {
            var name = request.Name.Trim();
            if (name.Length is 0 or > MaxNameLength) return NameError();
            binder.Name = name;
        }
        binder.IsPublic = request.IsPublic ?? binder.IsPublic;
        binder.IsSelling = request.IsSelling ?? binder.IsSelling;
        binder.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(binder, db, ct));
    }

    private static async Task<Results<NoContent, NotFound>> DeleteAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        var deleted = await db.Binders.Where(b => b.Id == id && b.OwnerId == ownerId).ExecuteDeleteAsync(ct);
        return deleted == 0 ? TypedResults.NotFound() : TypedResults.NoContent();
    }

    // Adds Copies identical physical cards.
    private static async Task<Results<Ok<BinderDetail>, NotFound, ValidationProblem>> AddCardsAsync(
        Guid id, AddBinderCardsRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var binder = await FindAsync(db, id, user, ct);
        if (binder is null) return TypedResults.NotFound();

        var errors = await ValidateCardAsync(request.Card, db, ct);
        if (request.Copies is < 1 or > MaxCopies) errors["copies"] = [$"Add 1 to {MaxCopies} copies at a time."];
        else if (await db.BinderCards.CountAsync(c => c.BinderId == id, ct) + request.Copies > MaxCardsPerBinder)
        {
            errors["copies"] = [$"A binder holds at most {MaxCardsPerBinder} cards."];
        }
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);

        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < request.Copies; i++)
        {
            var card = new BinderCard { BinderId = id, Condition = "", Finish = "", Language = "", CreatedAt = now, UpdatedAt = now };
            Apply(card, request.Card!);
            db.BinderCards.Add(card);
        }
        binder.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(binder, db, ct));
    }

    private static async Task<Results<Ok<BinderDetail>, NotFound, ValidationProblem>> UpdateCardAsync(
        Guid id, Guid cardId, BinderCardRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var binder = await FindAsync(db, id, user, ct);
        var card = binder is null ? null : await db.BinderCards.FirstOrDefaultAsync(c => c.Id == cardId && c.BinderId == id, ct);
        if (card is null) return TypedResults.NotFound();

        var errors = await ValidateCardAsync(request, db, ct);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);
        Apply(card, request);
        card.UpdatedAt = binder!.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(binder, db, ct));
    }

    private static async Task<Results<Ok<BinderDetail>, NotFound>> DeleteCardAsync(
        Guid id, Guid cardId, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var binder = await FindAsync(db, id, user, ct);
        if (binder is null || await db.BinderCards.Where(c => c.Id == cardId && c.BinderId == id).ExecuteDeleteAsync(ct) == 0)
        {
            return TypedResults.NotFound();
        }
        binder.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await DetailAsync(binder, db, ct));
    }

    // Moves cards from this binder into another of the user's binders, all or nothing. Returns this binder.
    private static async Task<Results<Ok<BinderDetail>, NotFound, ValidationProblem>> MoveCardsAsync(
        Guid id, MoveBinderCardsRequest request, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var binder = await FindAsync(db, id, user, ct);
        var target = request.ToBinderId is { } toId ? await FindAsync(db, toId, user, ct) : null;
        if (binder is null || target is null) return TypedResults.NotFound();

        var ids = (request.CardIds ?? []).Distinct().ToList();
        if (ids.Count == 0 || target.Id == binder.Id)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["cardIds"] = ["Choose cards and another binder."] });
        }
        if (await db.BinderCards.CountAsync(c => c.BinderId == target.Id, ct) + ids.Count > MaxCardsPerBinder)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["cardIds"] = [$"A binder holds at most {MaxCardsPerBinder} cards."] });
        }

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var moved = await db.BinderCards
            .Where(c => c.BinderId == id && ids.Contains(c.Id))
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.BinderId, target.Id).SetProperty(c => c.UpdatedAt, now), ct);
        if (moved != ids.Count) return TypedResults.NotFound(); // some card isn't in this binder: the transaction rolls back
        binder.UpdatedAt = target.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return TypedResults.Ok(await DetailAsync(binder, db, ct));
    }

    // Anyone can read a public binder; a private one is a 404, the same as one that doesn't exist.
    private static async Task<Results<Ok<PublicBinder>, NotFound>> GetPublicAsync(Guid id, DeckinoDbContext db, CancellationToken ct)
    {
        var found = await db.Binders.AsNoTracking()
            .Where(b => b.Id == id && b.IsPublic)
            .Join(db.Users, b => b.OwnerId, u => u.Id, (b, u) => new { Binder = b, Owner = u.UserName! })
            .FirstOrDefaultAsync(ct);
        if (found is null) return TypedResults.NotFound();

        var rows = await db.BinderCards.AsNoTracking().Where(c => c.BinderId == id).ToListAsync(ct);
        var cards = await LoadCardsAsync(db, rows.Select(r => r.ScryfallId), ct);
        // Notes are the owner's own; the public page shows what the cards are and how many.
        var groups = rows
            .GroupBy(r => (r.ScryfallId, r.Finish, r.Condition, r.Language))
            .Select(g => new PublicBinderCard(g.Key.ScryfallId, g.Key.Finish, g.Key.Condition, g.Key.Language, g.Count(), DeckCard.From(cards[g.Key.ScryfallId])))
            .OrderBy(g => g.Card.Name).ThenBy(g => g.Card.SetName).ThenBy(g => g.Finish).ThenBy(g => g.Condition)
            .ToList();
        return TypedResults.Ok(new PublicBinder(found.Binder.Id, found.Binder.Name, found.Owner, found.Binder.IsSelling, groups));
    }

    private static async Task<Dictionary<string, string[]>> ValidateCardAsync(BinderCardRequest? request, DeckinoDbContext db, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (request is null) return new() { ["card"] = ["Choose a card."] };
        if (!Conditions.Contains(request.Condition)) errors["condition"] = ["Choose a condition."];
        if (!Languages.Contains(request.Language)) errors["language"] = ["Choose a language."];
        if (request.Notes?.Trim().Length > MaxNotesLength) errors["notes"] = [$"Use at most {MaxNotesLength} characters."];
        var finishes = await db.Cards.Where(c => c.Id == request.ScryfallId).Select(c => c.Finishes).FirstOrDefaultAsync(ct);
        if (finishes is null) errors["scryfallId"] = ["That card doesn't exist."];
        else if (!Finishes.Contains(request.Finish) || !finishes.Contains(request.Finish)) errors["finish"] = ["This printing doesn't come in that finish."];
        return errors;
    }

    private static void Apply(BinderCard card, BinderCardRequest request)
    {
        card.ScryfallId = request.ScryfallId;
        card.Condition = request.Condition!;
        card.Finish = request.Finish!;
        card.Language = request.Language!;
        card.Notes = string.IsNullOrWhiteSpace(request.Notes) ? null : request.Notes.Trim();
    }

    private static Task<Binder?> FindAsync(DeckinoDbContext db, Guid id, ClaimsPrincipal user, CancellationToken ct)
    {
        var ownerId = OwnerId(user);
        return db.Binders.FirstOrDefaultAsync(b => b.Id == id && b.OwnerId == ownerId, ct);
    }

    private static async Task<BinderDetail> DetailAsync(Binder binder, DeckinoDbContext db, CancellationToken ct)
    {
        var rows = await db.BinderCards.AsNoTracking().Where(c => c.BinderId == binder.Id).OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).ToListAsync(ct);
        var cards = await LoadCardsAsync(db, rows.Select(r => r.ScryfallId), ct);
        return new BinderDetail(
            binder.Id, binder.Name, binder.IsPublic, binder.IsSelling, binder.CreatedAt, binder.UpdatedAt,
            rows.Select(r => new BinderCardDetail(r.Id, r.ScryfallId, r.Finish, r.Condition, r.Language, r.Notes, DeckCard.From(cards[r.ScryfallId]))).ToList());
    }

    private static Task<Dictionary<Guid, Card>> LoadCardsAsync(DeckinoDbContext db, IEnumerable<Guid> scryfallIds, CancellationToken ct)
    {
        var ids = scryfallIds.Distinct().ToList();
        return db.Cards.AsNoTracking().Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
    }

    private static ValidationProblem NameError() =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["name"] = [$"Use 1 to {MaxNameLength} characters."] });

    // RequireAuthorization guarantees the cookie's user ID claim.
    private static Guid OwnerId(ClaimsPrincipal user) => Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
}

public record SaveBinderRequest(string? Name, bool? IsPublic, bool? IsSelling);
public record BinderCardRequest(Guid ScryfallId, string? Finish, string? Condition, string? Language, string? Notes);
public record AddBinderCardsRequest(BinderCardRequest? Card, int Copies = 1);
public record ImportBinderRequest(string? Name, List<AddBinderCardsRequest?>? Cards);
public record MoveBinderCardsRequest(List<Guid>? CardIds, Guid? ToBinderId);

public record BinderSummary(Guid Id, string Name, bool IsPublic, bool IsSelling, int CardCount, string? Cover, DateTimeOffset UpdatedAt);

public record BinderDetail(
    Guid Id, string Name, bool IsPublic, bool IsSelling, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, List<BinderCardDetail> Cards);

public record BinderCardDetail(Guid Id, Guid ScryfallId, string Finish, string Condition, string Language, string? Notes, DeckCard Card);

public record PublicBinder(Guid Id, string Name, string Owner, bool IsSelling, List<PublicBinderCard> Cards);

public record PublicBinderCard(Guid ScryfallId, string Finish, string Condition, string Language, int Count, DeckCard Card);
