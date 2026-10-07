using System.Text.Json;
using System.Text.Json.Serialization;

namespace Deckino.Api.Catalogue;

// The parts of a Scryfall card object (one line of the default_cards bulk file) that Deckino keeps.
public sealed record ScryfallCard(
    Guid Id,
    Guid? OracleId,
    string Name,
    string Lang,
    DateOnly ReleasedAt,
    string Layout,
    string? ManaCost,
    decimal? Cmc,
    string? TypeLine,
    string? OracleText,
    string? Power,
    string? Toughness,
    string? Loyalty,
    string[]? Colors,
    string[]? ColorIdentity,
    string[]? Keywords,
    string Set,
    string SetName,
    string SetType,
    string CollectorNumber,
    string Rarity,
    string? Artist,
    string? FlavorText,
    Dictionary<string, string>? Legalities,
    ScryfallImages? ImageUris,
    ScryfallFace[]? CardFaces,
    bool FullArt,
    bool Promo,
    bool Digital,
    bool Oversized,
    string[]? Finishes,
    ScryfallPrices? Prices)
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        NumberHandling = JsonNumberHandling.AllowReadingFromString, // prices are strings
    };

    public Card ToCard()
    {
        var faces = CardFaces ?? [];
        string? Joined(Func<ScryfallFace, string?> part) =>
            faces.Length == 0 ? null : string.Join(" // ", faces.Select(part).Where(p => !string.IsNullOrEmpty(p)));

        return new Card
        {
            Id = Id,
            // reversible_card has no top-level oracle_id; both faces are the same card.
            OracleId = OracleId ?? faces.Select(f => f.OracleId).FirstOrDefault(o => o is not null)
                ?? throw new InvalidDataException($"Card {Id} has no oracle_id."),
            Name = Name,
            Lang = Lang,
            ReleasedAt = ReleasedAt,
            Layout = Layout,
            ManaCost = ManaCost ?? Joined(f => f.ManaCost),
            ManaValue = Cmc ?? faces.Select(f => f.Cmc).FirstOrDefault(c => c is not null) ?? 0,
            TypeLine = TypeLine ?? Joined(f => f.TypeLine),
            OracleText = OracleText,
            Power = Power,
            Toughness = Toughness,
            Loyalty = Loyalty,
            Colors = Colors ?? faces.SelectMany(f => f.Colors ?? []).Distinct().ToArray(),
            ColorIdentity = ColorIdentity ?? [],
            Keywords = Keywords ?? [],
            SetCode = Set,
            SetName = SetName,
            SetType = SetType,
            CollectorNumber = CollectorNumber,
            Rarity = Rarity,
            Artist = Artist ?? faces.Select(f => f.Artist).FirstOrDefault(a => a is not null),
            FlavorText = FlavorText,
            LegalFormats = FormatsWith("legal"),
            BannedFormats = FormatsWith("banned"),
            RestrictedFormats = FormatsWith("restricted"),
            Images = ImageUris?.ToImages(),
            Faces = faces.Select(f => new CardFace
            {
                Name = f.Name,
                ManaCost = NullIfEmpty(f.ManaCost),
                TypeLine = f.TypeLine,
                OracleText = f.OracleText,
                FlavorText = f.FlavorText,
                Power = f.Power,
                Toughness = f.Toughness,
                Loyalty = f.Loyalty,
                Images = f.ImageUris?.ToImages(),
            }).ToList(),
            FullArt = FullArt,
            Promo = Promo,
            Digital = Digital,
            Oversized = Oversized,
            Finishes = Finishes ?? [],
            Usd = Prices?.Usd,
            UsdFoil = Prices?.UsdFoil,
            UsdEtched = Prices?.UsdEtched,
            Eur = Prices?.Eur,
            EurFoil = Prices?.EurFoil,
            Tix = Prices?.Tix,
        };
    }

    private string[] FormatsWith(string status) =>
        Legalities?.Where(l => l.Value == status).Select(l => l.Key).Order().ToArray() ?? [];

    private static string? NullIfEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}

public sealed record ScryfallFace(
    string Name,
    Guid? OracleId,
    string? ManaCost,
    decimal? Cmc,
    string? TypeLine,
    string? OracleText,
    string? FlavorText,
    string? Power,
    string? Toughness,
    string? Loyalty,
    string? Artist,
    string[]? Colors,
    ScryfallImages? ImageUris);

public sealed record ScryfallImages(string Small, string Normal, string Large, string? ArtCrop)
{
    public CardImages ToImages() => new() { Small = Small, Normal = Normal, Large = Large, ArtCrop = ArtCrop };
}

public sealed record ScryfallPrices(
    decimal? Usd, decimal? UsdFoil, decimal? UsdEtched, decimal? Eur, decimal? EurFoil, decimal? Tix);

public sealed record ScryfallBulkData(DateTimeOffset UpdatedAt, Uri JsonlDownloadUri);
