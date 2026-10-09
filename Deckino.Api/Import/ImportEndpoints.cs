using System.Security.Claims;
using System.Text;
using Deckino.Api.Binders;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Import;

// Import is two steps: the preview parses a file and matches each line to a printing, the web app shows it for
// review (fixing or dropping what didn't match), and only then creates the deck or binder through the normal
// endpoints. Export writes the formats the importers read.
public static class ImportEndpoints
{
    private const int MaxLength = 1_000_000; // characters of pasted text or file
    private const int MaxLines = 5_000;

    public static void MapImportEndpoints(this WebApplication app)
    {
        var import = app.MapGroup("/api/import").RequireAuthorization();
        import.MapPost("/deck", (ImportRequest r, DeckinoDbContext db, CancellationToken ct) => PreviewAsync(r, DeckText.Parse, db, ct));
        import.MapPost("/binder", (ImportRequest r, DeckinoDbContext db, CancellationToken ct) => PreviewAsync(r, CollectionCsv.Parse, db, ct));

        app.MapGet("/api/decks/{id:guid}/export", ExportDeckAsync).RequireAuthorization();
        app.MapGet("/api/binders/{id:guid}/export", ExportBinderAsync).RequireAuthorization();
        app.MapGet("/api/public/decks/{id:guid}/export", ExportPublicDeckAsync);
    }

    private static async Task<Results<Ok<ImportPreview>, ValidationProblem>> PreviewAsync(
        ImportRequest request, Func<string, List<ParsedLine>> parse, DeckinoDbContext db, CancellationToken ct)
    {
        var text = request.Text ?? "";
        if (text.Trim().Length == 0) return Problem("Paste a list or choose a file.");
        if (text.Length > MaxLength) return Problem("That file is too big to import.");
        var parsed = parse(text);
        if (parsed.Count > MaxLines) return Problem($"Import at most {MaxLines} lines at a time.");
        if (parsed.Count == 0) return Problem("No cards found in that file.");
        return TypedResults.Ok(new ImportPreview(await ResolveAsync(parsed, db, ct)));
    }

    private static ValidationProblem Problem(string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["text"] = [message] });

    // Matches lines to printings: the Scryfall ID if given; else set code + collector number; else the name (in
    // the given set if there is one, otherwise the default printing). Double-faced cards match by front name too.
    private static async Task<List<ImportLine>> ResolveAsync(List<ParsedLine> lines, DeckinoDbContext db, CancellationToken ct)
    {
        var ids = lines.Where(l => l.ScryfallId is not null).Select(l => l.ScryfallId!.Value).Distinct().ToList();
        var printed = lines.Where(l => l.SetCode is not null && l.CollectorNumber is not null).ToList();
        var sets = printed.Select(l => l.SetCode!).Distinct().ToList();
        var numbers = printed.Select(l => l.CollectorNumber!).Distinct().ToList();
        var names = lines.Where(l => l.Name is not null).Select(l => l.Name!.ToLowerInvariant()).Distinct().ToList();

        var byId = await db.Cards.AsNoTracking().Where(c => ids.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        var inSets = await db.Cards.AsNoTracking().Where(c => sets.Contains(c.SetCode) && numbers.Contains(c.CollectorNumber)).ToListAsync(ct);
        var byName = names.Count == 0 ? [] : await db.Cards
            .FromSql($"SELECT * FROM cards WHERE lower(name) = ANY({names.ToArray()}) OR lower(split_part(name, ' // ', 1)) = ANY({names.ToArray()})")
            .AsNoTracking().ToListAsync(ct);
        var named = byName
            .SelectMany(c => new[] { (Key: c.Name.ToLowerInvariant(), Card: c), (Key: c.Name.Split(" // ")[0].ToLowerInvariant(), Card: c) })
            .Distinct()
            .ToLookup(x => x.Key, x => x.Card);
        var setNames = lines.Where(l => l.SetName is not null).Select(l => l.SetName!.ToLowerInvariant()).ToHashSet();

        return lines.Select(line =>
        {
            if (line.Name is null && line.ScryfallId is null)
            {
                return Unresolved(line, "This line isn't a card.");
            }
            var notes = new List<string>();
            Card? card = null;
            if (line.ScryfallId is { } id && byId.TryGetValue(id, out var exact)) card = exact;
            if (card is null && line.SetCode is not null && line.CollectorNumber is not null)
            {
                card = inSets.FirstOrDefault(c => c.SetCode == line.SetCode && string.Equals(c.CollectorNumber, line.CollectorNumber, StringComparison.OrdinalIgnoreCase));
                if (card is null && line.Name is not null) notes.Add($"No printing {line.SetCode.ToUpperInvariant()} #{line.CollectorNumber}, so the usual printing is used.");
            }
            if (card is null && line.Name is not null)
            {
                var candidates = named[line.Name.ToLowerInvariant()]
                    .Where(c => !NotCards.Contains(c.Layout) || c.Name.Equals(line.Name, StringComparison.OrdinalIgnoreCase))
                    .OrderBy(c => NotCards.Contains(c.Layout)) // a real card over an art card or token of the same name
                    .ThenByDescending(c => c.Name.Equals(line.Name, StringComparison.OrdinalIgnoreCase))
                    .ToList();
                card = candidates.Where(c => line.SetCode is not null && c.SetCode == line.SetCode
                                             || line.SetName is not null && c.SetName.Equals(line.SetName, StringComparison.OrdinalIgnoreCase))
                           .OrderByDescending(c => c.ReleasedAt).FirstOrDefault()
                       ?? candidates.FirstOrDefault(c => c.IsDefaultPrinting)
                       ?? candidates.OrderByDescending(c => c.ReleasedAt).FirstOrDefault();
            }
            if (card is null) return Unresolved(line, line.Name is null ? "No card has that Scryfall ID." : $"No card is named \"{line.Name}\".");

            var finish = line.Finish;
            if (!card.Finishes.Contains(finish))
            {
                finish = card.Finishes.Contains("nonfoil") ? "nonfoil" : card.Finishes[0];
                notes.Add($"This printing isn't made in {line.Finish}, so it's {finish}.");
            }
            var condition = ConditionOf(line.Condition);
            if (line.Condition is not null && condition is null) notes.Add($"Condition \"{line.Condition}\" isn't one Deckino knows.");
            var language = LanguageOf(line.Language);
            if (line.Language is not null && language is null) notes.Add($"Language \"{line.Language}\" isn't one Deckino knows.");
            if (line.Quantity is < 1 or > 999) notes.Add("The quantity must be 1 to 999.");

            return new ImportLine(line.Line, line.Text, line.Section, line.Quantity, finish, condition, language, line.Notes,
                DeckCard.From(card), null, notes.Count > 0 ? string.Join(" ", notes) : null);
        }).ToList();

        static ImportLine Unresolved(ParsedLine line, string problem) =>
            new(line.Line, line.Text, line.Section, line.Quantity, line.Finish, null, null, line.Notes, null, problem, null);
    }

    // Layouts that share names with real cards without being one (card search hides them too).
    private static readonly string[] NotCards = ["token", "double_faced_token", "art_series", "emblem"];

    // Deckino's condition codes from the names collection apps use (ManaBox "near_mint", Deckbox "Good (Lightly Played)").
    private static string? ConditionOf(string? value)
    {
        if (value is null) return null;
        var v = value.Trim().ToLowerInvariant().Replace('_', ' ');
        if (BinderEndpoints.Conditions.Contains(value.Trim().ToUpperInvariant())) return value.Trim().ToUpperInvariant();
        return v switch
        {
            _ when v.Contains("near mint") || v == "mint" => "NM",
            _ when v.Contains("light") || v.Contains("excellent") || v.StartsWith("good") => "LP",
            _ when v.Contains("heav") => "HP",
            _ when v.Contains("moderate") || v == "played" => "MP",
            _ when v.Contains("damage") || v == "poor" => "DMG",
            _ => null,
        };
    }

    private static readonly Dictionary<string, string> LanguageNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["english"] = "en", ["spanish"] = "es", ["french"] = "fr", ["german"] = "de", ["italian"] = "it", ["portuguese"] = "pt",
        ["japanese"] = "ja", ["korean"] = "ko", ["russian"] = "ru", ["simplified chinese"] = "zhs", ["chinese simplified"] = "zhs",
        ["traditional chinese"] = "zht", ["chinese traditional"] = "zht", ["phyrexian"] = "ph",
    };

    private static string? LanguageOf(string? value)
    {
        if (value is null) return null;
        var v = value.Trim();
        if (BinderEndpoints.Languages.Contains(v.ToLowerInvariant())) return v.ToLowerInvariant();
        return LanguageNames.GetValueOrDefault(v);
    }

    private static async Task<Results<FileContentHttpResult, NotFound>> ExportDeckAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var deck = await db.Decks.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id && d.OwnerId == ownerId, ct);
        return deck is null ? TypedResults.NotFound() : await DeckFileAsync(deck, db, ct);
    }

    // A public deck's list, for anyone: the same file its owner exports.
    private static async Task<Results<FileContentHttpResult, NotFound>> ExportPublicDeckAsync(Guid id, DeckinoDbContext db, CancellationToken ct) =>
        await PublicDeckEndpoints.FindAsync(db, id, ct) is var (deck, _) ? await DeckFileAsync(deck, db, ct) : TypedResults.NotFound();

    private static async Task<FileContentHttpResult> DeckFileAsync(Deck deck, DeckinoDbContext db, CancellationToken ct)
    {
        var cards = await DeckEndpoints.LoadCardsAsync(db, deck.Cards.Commander.Concat(deck.Cards.Mainboard).Concat(deck.Cards.Sideboard), ct);
        IEnumerable<(int, string, string, string, string)> Rows(List<DeckEntry> entries) =>
            entries.Select(e => (e.Quantity, ListName(cards[e.ScryfallId]), cards[e.ScryfallId].SetCode, cards[e.ScryfallId].CollectorNumber, e.Finish));
        var text = DeckText.Write([("Commander", Rows(deck.Cards.Commander)), ("Deck", Rows(deck.Cards.Mainboard)), ("Sideboard", Rows(deck.Cards.Sideboard))]);
        return TypedResults.File(Encoding.UTF8.GetBytes(text), "text/plain; charset=utf-8", FileName(deck.Name, "txt"));
    }

    // How decklists name a card: double-faced, adventure and flip cards by their front face; split cards in full.
    private static readonly string[] FrontNameLayouts = ["transform", "modal_dfc", "adventure", "flip", "reversible_card", "meld"];
    private static string ListName(Card card) => FrontNameLayouts.Contains(card.Layout) ? card.Name.Split(" // ")[0] : card.Name;

    private static async Task<Results<FileContentHttpResult, NotFound>> ExportBinderAsync(
        Guid id, ClaimsPrincipal user, DeckinoDbContext db, CancellationToken ct)
    {
        var ownerId = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var binder = await db.Binders.AsNoTracking().FirstOrDefaultAsync(b => b.Id == id && b.OwnerId == ownerId, ct);
        if (binder is null) return TypedResults.NotFound();
        var rows = await db.BinderCards.AsNoTracking().Where(c => c.BinderId == id)
            .Join(db.Cards, b => b.ScryfallId, c => c.Id, (b, c) => new { b.ScryfallId, b.Finish, b.Condition, b.Language, b.Notes, c.Name, c.SetCode, c.SetName, c.CollectorNumber })
            .ToListAsync(ct);
        var csv = new StringBuilder(CollectionCsv.Header).Append('\n');
        foreach (var g in rows.GroupBy(r => r).OrderBy(g => g.Key.Name).ThenBy(g => g.Key.SetCode))
        {
            var r = g.Key;
            csv.Append(CollectionCsv.Row(r.Name, r.SetCode, r.SetName, r.CollectorNumber, r.ScryfallId.ToString(), r.Finish,
                g.Count().ToString(), r.Condition, r.Language, r.Notes)).Append('\n');
        }
        return TypedResults.File(Encoding.UTF8.GetBytes(csv.ToString()), "text/csv; charset=utf-8", FileName(binder.Name, "csv"));
    }

    private static string FileName(string name, string extension)
    {
        var safe = new string(name.Select(c => char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' ? c : '-').ToArray()).Trim();
        return $"{(safe.Length > 0 ? safe : "deckino")}.{extension}";
    }
}

public record ImportRequest(string? Text);
public record ImportPreview(List<ImportLine> Lines);

// A line matched to a printing (Card set), or not (Problem says why). Note explains anything adjusted on the way.
public record ImportLine(
    int Line, string Text, string Section, int Quantity, string Finish, string? Condition, string? Language, string? Notes,
    DeckCard? Card, string? Problem, string? Note);
