using System.Text.Json;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

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

    [Fact]
    public void ExtractionAssetsKeepEveryFaceNormalImageSeparateFromArtworkCrops()
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
                { "image_uris": { "normal": "https://example/front-normal.jpg", "art_crop": "https://example/front-art.jpg" } },
                { "image_uris": { "normal": "https://example/back-normal.jpg", "art_crop": "https://example/back-art.jpg" } }
              ]
            }
            """;

        var card = JsonSerializer.Deserialize<ScryfallCardDto>(json)!;
        var assets = card.ResolveFullCards();

        Assert.Collection(assets,
            front =>
            {
                Assert.Equal("printing:face-0", front.AssetId);
                Assert.Equal(0, front.FaceIndex);
                Assert.EndsWith("front-normal.jpg", front.NormalUri, StringComparison.Ordinal);
            },
            back =>
            {
                Assert.Equal("printing:face-1", back.AssetId);
                Assert.Equal(1, back.FaceIndex);
                Assert.EndsWith("back-normal.jpg", back.NormalUri, StringComparison.Ordinal);
            });
    }
}
