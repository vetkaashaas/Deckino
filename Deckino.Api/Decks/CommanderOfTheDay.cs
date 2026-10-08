using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Decks;

// One commander per UTC day, the same for every visitor and every instance: a hash of the date picks from the
// sorted Oracle IDs of the default printings that are Commander-legal and can be a commander. Nothing is stored.
public static class CommanderOfTheDay
{
    // The day's pick, loaded once: requests that arrive while it loads wait for the same load.
    private sealed record Pick(DateOnly Day, Task<CommanderCard?> Card);
    private static readonly Lock Gate = new();
    private static Pick? cached;

    public static void MapCommanderOfTheDay(this WebApplication app) =>
        app.MapGet("/api/commander-of-the-day", GetAsync);

    // Development only (E2E): drops the day's pick, so the next request computes it again from the catalogue.
    internal static void Forget()
    {
        lock (Gate) cached = null;
    }

    private static async Task<Results<Ok<CommanderCard>, NotFound>> GetAsync(IServiceScopeFactory scopes, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        Pick pick;
        lock (Gate)
        {
            // A failed load, or none found (the catalogue may still be importing), is tried again by the next request.
            var stale = cached is not { } c || c.Day != today || c.Card.IsFaulted || c.Card is { IsCompletedSuccessfully: true, Result: null };
            if (stale) cached = new Pick(today, LoadAsync(scopes, today));
            pick = cached!;
        }
        return await pick.Card.WaitAsync(ct) is { } card ? TypedResults.Ok(card) : TypedResults.NotFound();
    }

    // Its own scope and no request token: it outlives the request that started it, and other requests share it.
    private static async Task<CommanderCard?> LoadAsync(IServiceScopeFactory scopes, DateOnly day)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<DeckinoDbContext>();

        // SQL narrows to plausible candidates; the commander rule itself is DeckLegality's, in one place. Only what
        // the rule reads (type line and rules text, the faces' too) is loaded; the chosen card is loaded in full below.
        var candidates = await db.Cards.AsNoTracking()
            .Where(c => c.IsDefaultPrinting && c.LegalFormats.Contains("commander")
                && (c.TypeLine == null || c.TypeLine.Contains("Legendary") || c.OracleText!.Contains("can be your commander")))
            .Select(c => new Card
            {
                Id = c.Id, OracleId = c.OracleId, TypeLine = c.TypeLine, OracleText = c.OracleText, Faces = c.Faces,
                Name = c.Name, Lang = "", Layout = "", SetCode = "", SetName = "", SetType = "", CollectorNumber = "", Rarity = "",
            })
            .ToListAsync();
        var eligible = candidates.Where(DeckLegality.CanBeCommander).OrderBy(c => c.OracleId).ToList();
        if (eligible.Count == 0) return null;

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(day.ToString("yyyy-MM-dd")));
        var chosen = eligible[(int)(BinaryPrimitives.ReadUInt64LittleEndian(hash) % (ulong)eligible.Count)];
        return CommanderCard.From(await db.Cards.AsNoTracking().FirstAsync(c => c.Id == chosen.Id));
    }
}

// Images: one, or one per face for double-faced cards (front first).
public record CommanderCard(Guid Id, string Name, string? TypeLine, List<string> Images, string? ArtCrop)
{
    public static CommanderCard From(Card c) => new(
        c.Id, c.Name, c.TypeLine,
        c.Images is { } images ? [images.Large] : c.Faces.Where(f => f.Images is not null).Select(f => f.Images!.Large).ToList(),
        c.FrontImages?.ArtCrop);
}
