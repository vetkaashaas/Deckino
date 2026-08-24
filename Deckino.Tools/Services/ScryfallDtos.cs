using System.Text.Json.Serialization;

namespace Deckino.Tools.Services;

internal sealed class ScryfallCardDto
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("oracle_id")]
    public string? OracleId { get; set; }

    [JsonPropertyName("illustration_id")]
    public string? IllustrationId { get; set; }

    [JsonPropertyName("games")]
    public string[] Games { get; set; } = [];

    public bool IsAvailableInPaper => Games.Contains("paper", StringComparer.Ordinal);

    [JsonPropertyName("set")]
    public string Set { get; set; } = string.Empty;

    [JsonPropertyName("set_name")]
    public string? SetName { get; set; }

    [JsonPropertyName("collector_number")]
    public string CollectorNumber { get; set; } = string.Empty;

    [JsonPropertyName("layout")]
    public string? Layout { get; set; }

    [JsonPropertyName("released_at")]
    public string? ReleasedAt { get; set; }

    [JsonPropertyName("image_uris")]
    public ScryfallImageUrisDto? ImageUris { get; set; }

    [JsonPropertyName("card_faces")]
    public ScryfallCardFaceDto[]? CardFaces { get; set; }

    public ResolvedArtwork? ResolveArtwork()
    {
        if (ImageUris?.ArtCrop is { } direct)
        {
            return new ResolvedArtwork(direct, IllustrationId);
        }
        var face = CardFaces?.FirstOrDefault(value => value.ImageUris?.ArtCrop is not null);
        return face?.ImageUris?.ArtCrop is { } crop
            ? new ResolvedArtwork(crop, face.IllustrationId)
            : null;
    }
}

internal sealed record ResolvedArtwork(string ArtCropUri, string? IllustrationId);

internal sealed class ScryfallImageUrisDto
{
    [JsonPropertyName("art_crop")]
    public string? ArtCrop { get; set; }
}

internal sealed class ScryfallCardFaceDto
{
    [JsonPropertyName("illustration_id")]
    public string? IllustrationId { get; set; }

    [JsonPropertyName("image_uris")]
    public ScryfallImageUrisDto? ImageUris { get; set; }
}

internal sealed class ScryfallOracleCardDto
{
    [JsonPropertyName("oracle_id")]
    public string OracleId { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("mana_cost")]
    public string? ManaCost { get; set; }

    [JsonPropertyName("type_line")]
    public string? TypeLine { get; set; }

    [JsonPropertyName("oracle_text")]
    public string? OracleText { get; set; }
}

internal sealed class ScryfallBulkDataEntryDto
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("updated_at")]
    public string UpdatedAt { get; set; } = string.Empty;

    [JsonPropertyName("jsonl_download_uri")]
    public Uri JsonlDownloadUri { get; set; } = default!;
}
