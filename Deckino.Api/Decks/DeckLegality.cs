using System.Text.RegularExpressions;
using Deckino.Api.Catalogue;

namespace Deckino.Api.Decks;

// Whether a deck follows its format, as warnings that never block saving. Banned / restricted / not legal comes
// from Scryfall's legalities on each card; Deckino adds only the construction rules below. Computed on demand,
// never stored, so ban-list changes from the catalogue sync apply straight away.
public static partial class DeckLegality
{
    private record Rules(string Name, int DeckSize, bool ExactSize, int Sideboard, int Copies);

    // Formats missing here (casual) have no rules.
    private static readonly Dictionary<string, Rules> Formats = new()
    {
        ["standard"] = new("Standard", 60, false, 15, 4),
        ["pioneer"] = new("Pioneer", 60, false, 15, 4),
        ["modern"] = new("Modern", 60, false, 15, 4),
        ["legacy"] = new("Legacy", 60, false, 15, 4),
        ["vintage"] = new("Vintage", 60, false, 15, 4),
        ["pauper"] = new("Pauper", 60, false, 15, 4),
        ["commander"] = new("Commander", 100, true, 0, 1),
    };

    private static readonly Dictionary<string, int> NumberWords = new(StringComparer.OrdinalIgnoreCase)
    {
        ["two"] = 2, ["three"] = 3, ["four"] = 4, ["five"] = 5, ["six"] = 6, ["seven"] = 7, ["eight"] = 8, ["nine"] = 9,
    };

    public static List<string> Check(string format, DeckCards deck, Dictionary<Guid, Card> cards)
    {
        if (!Formats.TryGetValue(format, out var rules)) return [];
        var isCommander = format == "commander";
        List<(DeckEntry Entry, Card Card)> With(IEnumerable<DeckEntry> entries) =>
            entries.Where(e => cards.ContainsKey(e.ScryfallId)).Select(e => (e, cards[e.ScryfallId])).ToList();

        // Commander has no sideboard, so there that section is a maybeboard and isn't checked. Other formats
        // have no commander, so a card left in that section counts as mainboard.
        var commanders = isCommander ? With(deck.Commander) : [];
        var main = isCommander ? With(deck.Mainboard) : With(deck.Commander.Concat(deck.Mainboard));
        var side = isCommander ? [] : With(deck.Sideboard);
        var played = commanders.Concat(main).Concat(side).ToList();
        var warnings = new List<string>();

        foreach (var card in played.Select(p => p.Card).DistinctBy(c => c.OracleId))
        {
            if (card.BannedFormats.Contains(format)) warnings.Add($"{card.Name} is banned in {rules.Name}.");
            else if (!card.LegalFormats.Contains(format) && !card.RestrictedFormats.Contains(format))
            {
                warnings.Add($"{card.Name} isn't legal in {rules.Name}.");
            }
        }

        // Copies count by Oracle card, across printings, finishes and sections.
        foreach (var group in played.GroupBy(p => p.Card.OracleId))
        {
            var card = group.First().Card;
            var copies = group.Sum(p => p.Entry.Quantity);
            var limit = card.RestrictedFormats.Contains(format) ? 1 : CopyLimit(card, rules.Copies);
            if (copies > limit)
            {
                warnings.Add(limit == 1
                    ? $"{card.Name}: {copies} copies, but {rules.Name} allows only 1."
                    : $"{card.Name}: {copies} copies, but {rules.Name} allows up to {limit}.");
            }
        }

        var size = commanders.Concat(main).Sum(p => p.Entry.Quantity);
        if (rules.ExactSize && size != rules.DeckSize)
        {
            warnings.Add($"A {rules.Name} deck has exactly {rules.DeckSize} cards, including the commander. This one has {size}.");
        }
        else if (size < rules.DeckSize)
        {
            warnings.Add($"A {rules.Name} deck needs at least {rules.DeckSize} mainboard cards. This one has {size}.");
        }
        var sideboard = side.Sum(p => p.Entry.Quantity);
        if (!isCommander && sideboard > rules.Sideboard)
        {
            warnings.Add($"A {rules.Name} sideboard holds at most {rules.Sideboard} cards. This one has {sideboard}.");
        }

        if (isCommander) warnings.AddRange(CheckCommanders(commanders.Select(p => p.Card).ToList(), main));
        return warnings.Distinct().ToList(); // the same card twice as commander (two printings) gives the same warning twice
    }

    private static IEnumerable<string> CheckCommanders(List<Card> commanders, List<(DeckEntry Entry, Card Card)> main)
    {
        if (commanders.Count == 0)
        {
            yield return "Choose a commander.";
            yield break;
        }
        if (commanders.Count == 2 && !ArePartners(commanders[0], commanders[1]) && !ArePartners(commanders[1], commanders[0]))
        {
            yield return $"{commanders[0].Name} and {commanders[1].Name} can't be commanders together.";
        }
        foreach (var commander in commanders)
        {
            var background = commanders.Count == 2 && TypeLine(commander).Contains("Background")
                && commanders.Any(c => Text(c).Contains("Choose a Background"));
            if (!background && !CanBeCommander(commander)) yield return $"{commander.Name} can't be your commander.";
        }

        var identity = commanders.SelectMany(c => c.ColorIdentity).ToHashSet();
        foreach (var card in main.Select(p => p.Card).DistinctBy(c => c.OracleId))
        {
            if (!card.ColorIdentity.All(identity.Contains)) yield return $"{card.Name} is outside the commander's colour identity.";
        }
    }

    // null: any number of copies.
    private static int? CopyLimit(Card card, int formatLimit)
    {
        if (TypeLine(card).StartsWith("Basic")) return null;
        var text = Text(card);
        if (text.Contains("A deck can have any number of cards named")) return null;
        var upTo = UpToCopies().Match(text);
        return upTo.Success && NumberWords.TryGetValue(upTo.Groups[1].Value, out var n) ? Math.Max(n, formatLimit) : formatLimit;
    }

    internal static bool CanBeCommander(Card card)
    {
        var front = TypeLine(card).Split(" // ")[0];
        return front.Contains("Legendary") && front.Contains("Creature") || Text(card).Contains("can be your commander");
    }

    // ponytail: the classic pairings only; newer "Partner—<group>" variants show as a warning until added here.
    private static bool ArePartners(Card a, Card b)
    {
        string textA = Text(a), textB = Text(b);
        return PlainPartner().IsMatch(textA) && PlainPartner().IsMatch(textB)
            || textA.Contains($"Partner with {b.Name}")
            || textA.Contains("Friends forever") && textB.Contains("Friends forever")
            || textA.Contains("Choose a Background") && TypeLine(b).Contains("Background")
            || textA.Contains("Doctor's companion") && TypeLine(b).Contains("Time Lord Doctor");
    }

    private static string TypeLine(Card card) => card.TypeLine ?? card.Faces.FirstOrDefault()?.TypeLine ?? "";

    private static string Text(Card card) =>
        string.Join("\n", new[] { card.OracleText }.Concat(card.Faces.Select(f => f.OracleText)).Where(t => t is not null));

    [GeneratedRegex(@"^Partner( \(|$)", RegexOptions.Multiline)]
    private static partial Regex PlainPartner();

    [GeneratedRegex(@"A deck can have up to (\w+) cards named")]
    private static partial Regex UpToCopies();
}
