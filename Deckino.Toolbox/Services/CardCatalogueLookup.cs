using System.IO;
using System.Text.Json;
using Dapper;
using Deckino.Toolbox.Data;

namespace Deckino.Toolbox.Services;

// PrintingId is the printing a model matched, when its labels are on this computer.
// The parameterless constructors are for Dapper: SQLite types a NULL column as bytes, which matches no positional
// constructor, so a missing art path or printing would fail the whole query.
public sealed record CatalogueCard(string OracleId, string Name, string? ArtPath, string? PrintingId)
{
    public CatalogueCard() : this("", "", null, null) { }
}

public sealed record CataloguePrinting(
    string PrintingId, string SetCode, string? SetName, string CollectorNumber, string? ArtPath)
{
    public CataloguePrinting() : this("", "", null, "", null) { }
}

// Card names and cached full-card images for the Card Identification page, from the synced Scryfall catalogue.
// Image paths are stored relative to the data root and returned absolute.
public sealed class CardCatalogueLookup(Database database, TrainingPaths paths)
{
    private const string ArtForOracle =
        """
        (SELECT i.file_path FROM cards c JOIN card_images i ON i.scryfall_id = c.scryfall_id
         WHERE c.oracle_id = o.oracle_id AND i.status = 'downloaded' ORDER BY c.released_at DESC, i.face_index LIMIT 1)
        """;
    private readonly Dictionary<string, (string? Printing, int Face)[]?> _prototypePrintings = new(StringComparer.Ordinal);

    // The face of the printing the model matched (its prototype) when that model's labels are on this computer,
    // else the newest printing's front.
    public async Task<CatalogueCard?> FindAsync(string oracleId, string? modelVersion, int? prototype)
    {
        var (printing, face) = await PrototypeAsync(modelVersion, prototype);
        await using var connection = database.OpenConnection();
        var card = await connection.QuerySingleOrDefaultAsync<CatalogueCard>(
            $"""
            SELECT o.oracle_id AS OracleId, o.name AS Name,
                   COALESCE((SELECT file_path FROM card_images WHERE scryfall_id = $printing AND status = 'downloaded'
                             ORDER BY face_index = $face DESC, face_index LIMIT 1),
                            {ArtForOracle}) AS ArtPath,
                   $printing AS PrintingId
            FROM oracle_cards o WHERE o.oracle_id = $oracleId
            """,
            new { oracleId, printing, face });
        return card is null ? null : card with { ArtPath = Absolute(card.ArtPath) };
    }

    public async Task<IReadOnlyList<CatalogueCard>> SearchAsync(string text)
    {
        text = text.Trim();
        if (text.Length < 2) return [];
        var pattern = "%" + text.Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_") + "%";
        await using var connection = database.OpenConnection();
        return (await connection.QueryAsync<CatalogueCard>(
            $"""
            SELECT o.oracle_id AS OracleId, o.name AS Name, {ArtForOracle} AS ArtPath, NULL AS PrintingId
            FROM oracle_cards o WHERE o.name LIKE $pattern ESCAPE '\'
            ORDER BY lower(o.name) = lower($text) DESC, length(o.name), o.name LIMIT 24
            """,
            new { pattern, text })).Select(card => card with { ArtPath = Absolute(card.ArtPath) }).ToList();
    }

    // Every paper printing of a card, newest first, for picking the exact one in a photo.
    public async Task<IReadOnlyList<CataloguePrinting>> PrintingsAsync(string oracleId)
    {
        await using var connection = database.OpenConnection();
        return (await connection.QueryAsync<CataloguePrinting>(
            """
            SELECT c.scryfall_id AS PrintingId, c.set_code AS SetCode, s.name AS SetName,
                   c.collector_number AS CollectorNumber,
                   (SELECT file_path FROM card_images WHERE scryfall_id = c.scryfall_id AND status = 'downloaded'
                    ORDER BY face_index LIMIT 1) AS ArtPath
            FROM cards c LEFT JOIN sets s ON s.code = c.set_code
            WHERE c.oracle_id = $oracleId AND c.is_paper = 1
            ORDER BY c.released_at DESC, c.set_code, length(c.collector_number), c.collector_number
            """,
            new { oracleId })).Select(printing => printing with { ArtPath = Absolute(printing.ArtPath) }).ToList();
    }

    // The printing behind a model's prototype, when that model's labels are on this computer.
    public async Task<string?> PrintingForPrototypeAsync(string? modelVersion, int? prototype) =>
        (await PrototypeAsync(modelVersion, prototype)).Printing;

    // The printing and face behind a model's prototype. Models from before per-face references name no face,
    // which reads as the front.
    private async Task<(string? Printing, int Face)> PrototypeAsync(string? modelVersion, int? prototype)
    {
        // The first call per model parses a multi-MB labels.json, so keep it off the caller's (UI) thread.
        var printings = modelVersion is null ? null : await Task.Run(() => PrototypePrintings(modelVersion));
        return prototype is { } index && printings is not null && index >= 0 && index < printings.Length
            ? printings[index]
            : (null, 0);
    }

    private string? Absolute(string? relativePath) =>
        relativePath is null ? null : CardImageService.AbsolutePath(paths.DataRoot, relativePath);

    // Reprints that reuse an illustration look the same to the artwork model, so a guess of either is right.
    public async Task<bool> SameArtworkAsync(string printingId, string otherPrintingId)
    {
        if (string.Equals(printingId, otherPrintingId, StringComparison.OrdinalIgnoreCase)) return true;
        await using var connection = database.OpenConnection();
        return await connection.ExecuteScalarAsync<long>(
            """
            SELECT COUNT(*) FROM cards a JOIN cards b ON b.illustration_id = a.illustration_id
            WHERE a.scryfall_id = $printingId AND b.scryfall_id = $otherPrintingId AND a.illustration_id IS NOT NULL
            """,
            new { printingId, otherPrintingId }) > 0;
    }

    private (string? Printing, int Face)[]? PrototypePrintings(string modelVersion)
    {
        lock (_prototypePrintings)
        {
            if (_prototypePrintings.TryGetValue(modelVersion, out var cached)) return cached;
            var path = Path.Combine(paths.MobileArtworkRoot, modelVersion, "labels.json");
            (string? Printing, int Face)[]? printings = null;
            if (File.Exists(path))
            {
                using var stream = File.OpenRead(path);
                using var document = JsonDocument.Parse(stream);
                printings = document.RootElement.GetProperty("prototypes").EnumerateArray()
                    .Select(item => (
                        item.TryGetProperty("printing_id", out var id) ? id.GetString() : null,
                        item.TryGetProperty("face_index", out var face) && face.ValueKind == JsonValueKind.Number
                            ? face.GetInt32() : 0))
                    .ToArray();
            }
            _prototypePrintings[modelVersion] = printings;
            return printings;
        }
    }
}
