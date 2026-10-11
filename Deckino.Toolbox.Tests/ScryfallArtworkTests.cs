using System.Text.Json;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class ScryfallArtworkTests
{
    [Fact]
    public void EveryFaceOfADoubleFacedCardGetsItsOwnLargeImageAndIllustration()
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
                { "illustration_id": "front-art", "image_uris": { "large": "https://example/front-large.jpg" } },
                { "illustration_id": "back-art", "image_uris": { "large": "https://example/back-large.jpg" } }
              ]
            }
            """;

        var card = JsonSerializer.Deserialize<ScryfallCardDto>(json)!;

        Assert.Collection(card.ResolveCardImages(),
            front =>
            {
                Assert.Equal("printing:face-0", front.ImageId);
                Assert.Equal(0, front.FaceIndex);
                Assert.EndsWith("front-large.jpg", front.ImageUri, StringComparison.Ordinal);
                Assert.Equal("front-art", front.IllustrationId);
            },
            back =>
            {
                Assert.Equal("printing:face-1", back.ImageId);
                Assert.Equal(1, back.FaceIndex);
                Assert.EndsWith("back-large.jpg", back.ImageUri, StringComparison.Ordinal);
                Assert.Equal("back-art", back.IllustrationId);
            });
    }

    [Fact]
    public void ASingleImageCardWithTextFacesHasOneImageWithTheCardIllustration()
    {
        const string json =
            """
            {
              "id": "split",
              "name": "Left // Right",
              "set": "tst",
              "collector_number": "2",
              "games": ["paper"],
              "illustration_id": "split-art",
              "image_uris": { "large": "https://example/split-large.jpg" },
              "card_faces": [ { "name": "Left" }, { "name": "Right" } ]
            }
            """;

        var image = Assert.Single(JsonSerializer.Deserialize<ScryfallCardDto>(json)!.ResolveCardImages());

        Assert.Equal("split:front", image.ImageId);
        Assert.Equal("split-art", image.IllustrationId);
    }
}
