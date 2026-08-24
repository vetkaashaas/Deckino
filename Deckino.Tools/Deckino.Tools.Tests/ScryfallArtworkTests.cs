using System.Text.Json;
using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class ScryfallArtworkTests
{
    [Fact]
    public void DoubleFacedArtworkKeepsCropAndIllustrationIdentityOnTheSameFace()
    {
        const string json =
            """
            {
              "id": "printing",
              "name": "Front // Back",
              "set": "tst",
              "collector_number": "1",
              "games": ["paper"],
              "card_faces": [
                { "illustration_id": "front-art", "image_uris": { "art_crop": "https://example/front.jpg" } },
                { "illustration_id": "back-art", "image_uris": { "art_crop": "https://example/back.jpg" } }
              ]
            }
            """;

        var card = JsonSerializer.Deserialize<ScryfallCardDto>(json)!;
        var artwork = card.ResolveArtwork();

        Assert.NotNull(artwork);
        Assert.Equal("https://example/front.jpg", artwork.ArtCropUri);
        Assert.Equal("front-art", artwork.IllustrationId);
    }
}
