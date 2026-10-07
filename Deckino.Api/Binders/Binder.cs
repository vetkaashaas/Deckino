namespace Deckino.Api.Binders;

// A user's binder of physical cards. Private until IsPublic; IsSelling only changes how a public binder is shown.
public class Binder
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public required string Name { get; set; }
    public bool IsPublic { get; set; }
    public bool IsSelling { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

// One physical card. There is no quantity: four copies are four rows.
public class BinderCard
{
    public Guid Id { get; set; }
    public Guid BinderId { get; set; }
    public Guid ScryfallId { get; set; } // the catalogue printing; Language labels the physical card
    public required string Condition { get; set; } // NM, LP, MP, HP or DMG
    public required string Finish { get; set; } // nonfoil, foil or etched
    public required string Language { get; set; } // a Scryfall language code
    public string? Notes { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
