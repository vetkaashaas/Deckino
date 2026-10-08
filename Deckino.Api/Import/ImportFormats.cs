using System.Text;
using System.Text.RegularExpressions;

namespace Deckino.Api.Import;

// One line of an imported file, as written: what card it names and how, before it's matched to the catalogue.
// Importers never invent what the file doesn't say: Condition and Language stay null when absent.
public record ParsedLine(
    int Line, string Text, string Section, int Quantity, string Finish,
    string? Name, string? SetCode, string? SetName, string? CollectorNumber, Guid? ScryfallId,
    string? Condition, string? Language, string? Notes);

// Decklists as text: Arena and MTGO lists, and the text exports of Moxfield and Archidekt, which share the shape
// "4 Lightning Bolt (2X2) 117 *F*", TappedOut's "1x Name *CMDR*", and ManaBox's "// COMMANDER" block. Section headers ("Commander", "Deck",
// "SIDEBOARD:", "// Sideboard"), MTGO's "SB: " prefix, Archidekt's "[Commander]" categories and TappedOut's
// *CMDR* pick the section; "1x" quantities are fine.
public static partial class DeckText
{
    private const int MaxSideboard = 15;

    public static List<ParsedLine> Parse(string text)
    {
        var lines = new List<ParsedLine>();
        var section = "mainboard";
        var number = 0;
        var marked = false; // a header, "SB:" or category said where cards go
        var block = 0; // groups of card lines between blank lines
        var blockOf = new List<int>(); // per line in `lines`
        var blockHasCards = false;
        foreach (var raw in text.Split('\n'))
        {
            number++;
            var line = raw.Trim();
            if (line.Length == 0)
            {
                // ManaBox writes "// COMMANDER", the commander, a blank line, then the deck with no header.
                if (blockHasCards && section == "commander") section = "mainboard";
                if (blockHasCards) block++;
                blockHasCards = false;
                continue;
            }
            var header = Header().Match(line);
            if (header.Success)
            {
                section = SectionOf(header.Groups[1].Value) ?? section;
                marked = true;
                continue;
            }
            if (line.StartsWith('#') || About().IsMatch(line)) continue;

            var lineSection = section;
            if (line.StartsWith("SB:", StringComparison.OrdinalIgnoreCase))
            {
                lineSection = "sideboard";
                line = line[3..].Trim();
                marked = true;
            }
            var category = Category().Match(line);
            if (category.Success)
            {
                var named = SectionOf(category.Groups[1].Value);
                marked |= named is not null;
                lineSection = named ?? lineSection;
                line = Category().Replace(line, "").Trim();
            }
            line = Tags().Replace(line, "").Trim(); // Archidekt's ^Tag^ labels

            var card = CardLine().Match(line);
            blockOf.Add(block);
            if (!card.Success)
            {
                lines.Add(new ParsedLine(number, raw.Trim(), lineSection, 0, "nonfoil", null, null, null, null, null, null, null, null));
                continue;
            }
            blockHasCards = true;
            // Markers after the card: *F* / *E* for foil and etched (Arena, Moxfield, TappedOut), *CMDR* (TappedOut).
            var finish = "nonfoil";
            foreach (Match marker in Marker().Matches(card.Groups["markers"].Value))
            {
                switch (marker.Groups[1].Value.ToUpperInvariant())
                {
                    case "F" or "FOIL": finish = "foil"; break;
                    case "E" or "ETCHED": finish = "etched"; break;
                    case "CMDR":
                        lineSection = "commander";
                        marked = true;
                        break;
                }
            }
            lines.Add(new ParsedLine(
                number, raw.Trim(), lineSection, int.Parse(card.Groups["qty"].Value), finish,
                card.Groups["name"].Value.Trim().Replace(" / ", " // "), // Moxfield writes "A / B" for Scryfall's "A // B"
                card.Groups["set"].Success ? card.Groups["set"].Value.ToLowerInvariant() : null, null,
                card.Groups["number"].Success ? card.Groups["number"].Value : null,
                null, null, null, null));
        }

        // MTGO lists have no headers: the main deck, one blank line, then a sideboard of up to 15 cards. Lists
        // grouped by type also use blank lines, so only that exact shape counts; anything else stays mainboard.
        var blocks = blockHasCards ? block + 1 : block;
        var second = lines.Where((_, i) => blockOf[i] == 1).Sum(l => l.Quantity);
        if (!marked && blocks == 2 && second <= MaxSideboard)
        {
            return lines.Select((l, i) => blockOf[i] == 1 ? l with { Section = "sideboard" } : l).ToList();
        }
        return lines;
    }

    private static string? SectionOf(string label) => label.Trim().ToLowerInvariant() switch
    {
        var l when l.StartsWith("commander") => "commander",
        var l when l.StartsWith("sideboard") || l.StartsWith("maybeboard") || l.StartsWith("companion") || l == "considering" => "sideboard",
        "deck" or "main" or "mainboard" or "main deck" => "mainboard",
        _ => null,
    };

    // A Deckino deck as text, in Arena's layout (which Moxfield and Archidekt import too).
    public static string Write(IEnumerable<(string Section, IEnumerable<(int Quantity, string Name, string SetCode, string Number, string Finish)> Cards)> sections)
    {
        var text = new StringBuilder();
        foreach (var (section, cards) in sections)
        {
            var list = cards.ToList();
            if (list.Count == 0) continue;
            if (text.Length > 0) text.Append('\n');
            text.Append(section).Append('\n');
            foreach (var c in list)
            {
                text.Append($"{c.Quantity} {c.Name} ({c.SetCode.ToUpperInvariant()}) {c.Number}");
                if (c.Finish != "nonfoil") text.Append(c.Finish == "foil" ? " *F*" : " *E*");
                text.Append('\n');
            }
        }
        return text.ToString();
    }

    [GeneratedRegex(@"^(?://\s*)?(commander|deck|main ?deck|mainboard|sideboard|maybeboard|companion|considering)\s*:?\s*(\(\d+\))?$", RegexOptions.IgnoreCase)]
    private static partial Regex Header();

    // Arena exports can open with "About" and "Name <deck name>".
    [GeneratedRegex(@"^(about|name\s.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex About();

    [GeneratedRegex(@"\[([^\]]*)\]")]
    private static partial Regex Category();

    [GeneratedRegex(@"\^[^^]*\^")]
    private static partial Regex Tags();

    [GeneratedRegex(@"^(?<qty>\d{1,4})x?\s+(?<name>.+?)(?:\s+\((?<set>[A-Za-z0-9]{2,6})\)(?:\s+(?<number>[^\s*]+))?)?(?<markers>(?:\s+\*[A-Za-z]+\*)*)$")]
    private static partial Regex CardLine();

    [GeneratedRegex(@"\*([A-Za-z]+)\*")]
    private static partial Regex Marker();
}

// Collections as CSV, read by column name: ManaBox's export, Deckbox's, and Deckino's own (which uses ManaBox's
// column names). One row is one or more identical physical cards.
public static class CollectionCsv
{
    private static readonly string[] NameColumns = ["name", "card name", "card"];
    private static readonly string[] SetCodeColumns = ["set code", "set", "edition code"];
    private static readonly string[] SetNameColumns = ["set name", "edition"];
    private static readonly string[] NumberColumns = ["collector number", "card number", "number"];
    private static readonly string[] IdColumns = ["scryfall id", "scryfall_id"];
    private static readonly string[] QuantityColumns = ["quantity", "count", "qty"];
    private static readonly string[] FoilColumns = ["foil", "finish", "printing"];
    private static readonly string[] ConditionColumns = ["condition"];
    private static readonly string[] LanguageColumns = ["language", "lang"];
    private static readonly string[] NotesColumns = ["notes", "note", "comment"];

    public static List<ParsedLine> Parse(string text)
    {
        var rows = ReadRows(text);
        if (rows.Count == 0) return [];
        var header = rows[0].Select(h => h.Trim().ToLowerInvariant()).ToList();
        int Col(string[] names) => header.FindIndex(names.Contains);
        var (name, setCode, setName, number, id, quantity, foil, condition, language, notes) = (
            Col(NameColumns), Col(SetCodeColumns), Col(SetNameColumns), Col(NumberColumns), Col(IdColumns),
            Col(QuantityColumns), Col(FoilColumns), Col(ConditionColumns), Col(LanguageColumns), Col(NotesColumns));

        var lines = new List<ParsedLine>();
        for (var i = 1; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.All(string.IsNullOrWhiteSpace)) continue;
            string? Get(int column) => column >= 0 && column < row.Count && !string.IsNullOrWhiteSpace(row[column]) ? Unguard(row[column].Trim()) : null;
            var count = int.TryParse(Get(quantity), out var q) ? q : 1;
            lines.Add(new ParsedLine(
                i + 1, string.Join(",", row), "", count, FinishOf(Get(foil)),
                Get(name), Get(setCode)?.ToLowerInvariant(), Get(setName), Get(number),
                Guid.TryParse(Get(id), out var scryfallId) ? scryfallId : null,
                Get(condition), Get(language), Get(notes)));
        }
        return lines;
    }

    // Undoes Escape's formula guard: "'-signed" was "-signed", and "''=x" was "'=x".
    private static string Unguard(string value) => value.Length > 1 && value[0] == '\'' && Guarded(value[1..]) ? value[1..] : value;

    // What Escape puts an apostrophe in front of: a formula start, or an apostrophe before one (so it survives Unguard).
    private static bool Guarded(string value) =>
        value.Length > 0 && ("=+-@".Contains(value[0]) || value.Length > 1 && value[0] == '\'' && "=+-@".Contains(value[1]));

    private static string FinishOf(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "foil" or "true" or "yes" or "1" or "y" => "foil",
        "etched" or "etched foil" => "etched",
        _ => "nonfoil",
    };

    // RFC 4180: commas, quoted fields with "" for a quote, and line breaks inside quotes.
    private static List<List<string>> ReadRows(string text)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
            }
            else if (c == '"' && field.Length == 0) quoted = true;
            else if (c == ',') { row.Add(field.ToString()); field.Clear(); }
            else if (c == '\n')
            {
                row.Add(field.ToString().TrimEnd('\r'));
                field.Clear();
                rows.Add(row);
                row = [];
            }
            else field.Append(c);
        }
        if (field.Length > 0 || row.Count > 0)
        {
            row.Add(field.ToString().TrimEnd('\r'));
            rows.Add(row);
        }
        return rows;
    }

    public const string Header = "Name,Set code,Set name,Collector number,Scryfall ID,Foil,Quantity,Condition,Language,Notes";

    public static string Row(params string?[] fields) => string.Join(",", fields.Select(Escape));

    // Quotes when needed, and defuses spreadsheet formulas: a cell starting with = + - @ is text, not a formula.
    private static string Escape(string? value)
    {
        value ??= "";
        if (Guarded(value)) value = "'" + value;
        return value.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{value.Replace("\"", "\"\"")}\"" : value;
    }
}
