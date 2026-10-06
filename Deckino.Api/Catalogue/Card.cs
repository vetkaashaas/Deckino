namespace Deckino.Api.Catalogue;

// One Scryfall printing. Written only by CatalogueSync; never deleted (user data references Id).
public class Card
{
    public Guid Id { get; set; } // Scryfall ID: the exact printing
    public Guid OracleId { get; set; } // groups printings of the same card
    public required string Name { get; set; }
    public required string Lang { get; set; }
    public DateOnly ReleasedAt { get; set; }
    public required string Layout { get; set; }
    public string? ManaCost { get; set; }
    public decimal ManaValue { get; set; }
    public string? TypeLine { get; set; }
    public string? OracleText { get; set; }
    public string? Power { get; set; }
    public string? Toughness { get; set; }
    public string? Loyalty { get; set; }
    public string[] Colors { get; set; } = [];
    public string[] ColorIdentity { get; set; } = [];
    public string[] Keywords { get; set; } = [];
    public required string SetCode { get; set; }
    public required string SetName { get; set; }
    public required string SetType { get; set; }
    public required string CollectorNumber { get; set; }
    public required string Rarity { get; set; }
    public string? Artist { get; set; }
    public string? FlavorText { get; set; }
    // Scryfall legality keys; any format in none of these is not legal.
    public string[] LegalFormats { get; set; } = [];
    public string[] BannedFormats { get; set; } = [];
    public string[] RestrictedFormats { get; set; } = [];
    public CardImages? Images { get; set; } // single-image layouts; double-faced cards have per-face images
    public List<CardFace> Faces { get; set; } = []; // empty for single-faced cards
    public bool FullArt { get; set; }
    public bool Promo { get; set; }
    public bool Digital { get; set; }
    public bool Oversized { get; set; }
    public string[] Finishes { get; set; } = [];
    public decimal? Usd { get; set; }
    public decimal? UsdFoil { get; set; }
    public decimal? UsdEtched { get; set; }
    public decimal? Eur { get; set; }
    public decimal? EurFoil { get; set; }
    public decimal? Tix { get; set; }
    public bool IsDefaultPrinting { get; set; } // exactly one per OracleId, see CatalogueSync.DefaultPrintingSql
    public bool IsMissingUpstream { get; set; }
}

public class CardImages
{
    public required string Small { get; set; }
    public required string Normal { get; set; }
    public required string Large { get; set; }
}

public class CardFace
{
    public required string Name { get; set; }
    public string? ManaCost { get; set; }
    public string? TypeLine { get; set; }
    public string? OracleText { get; set; }
    public string? FlavorText { get; set; }
    public string? Power { get; set; }
    public string? Toughness { get; set; }
    public string? Loyalty { get; set; }
    public CardImages? Images { get; set; }
}

public class CatalogueSyncRun
{
    public Guid Id { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public DateTimeOffset BulkUpdatedAt { get; set; } // Scryfall's updated_at for the imported file
    public int CardsRead { get; set; }
    public int DigitalSkipped { get; set; }
    public int Inserted { get; set; }
    public int Updated { get; set; }
    public int MissingUpstream { get; set; }
    public string? Error { get; set; }
}
