namespace Deckino.Api.Decks;

// A user's deck. The cards are one JSONB column of Scryfall IDs (see DeckinoDbContext); card data stays in the catalogue.
public class Deck
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public required string Name { get; set; }
    public required string Format { get; set; } // a key from DeckEndpoints.Formats
    public DeckCards Cards { get; set; } = new();
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public class DeckCards
{
    public List<DeckEntry> Commander { get; set; } = [];
    public List<DeckEntry> Mainboard { get; set; } = [];
    public List<DeckEntry> Sideboard { get; set; } = [];
}

// Identified by (ScryfallId, Finish) within its section.
public class DeckEntry
{
    public Guid ScryfallId { get; set; }
    public int Quantity { get; set; }
    public required string Finish { get; set; } // nonfoil, foil or etched, as in Scryfall's finishes
}
