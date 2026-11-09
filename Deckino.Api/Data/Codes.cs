using System.Text.Json.Serialization;

namespace Deckino.Api.Data;

// The codes the API sends and takes. JSON carries them as strings (the enum converter in Program.cs), and the database
// stores the same strings, so a stored code and its JSON are one value.

public enum Finish { Nonfoil, Foil, Etched } // as in Scryfall's finishes

public enum Condition
{
    [JsonStringEnumMemberName("NM")] NM,
    [JsonStringEnumMemberName("LP")] LP,
    [JsonStringEnumMemberName("MP")] MP,
    [JsonStringEnumMemberName("HP")] HP,
    [JsonStringEnumMemberName("DMG")] DMG,
}

public enum Currency { Usd, Eur }

public enum CaptureKind { Locked, Unidentified } // a training capture: the scanner locked on a card, or found none

// How the phone found a capture's card: the artwork model's embeddings, or the printed name among its top 5 or all cards.
public enum RecognitionMethod
{
    [JsonStringEnumMemberName("embeddings")] Embeddings,
    [JsonStringEnumMemberName("ocr-top5")] OcrTop5,
    [JsonStringEnumMemberName("ocr-all")] OcrAll,
}

public static class Codes
{
    public static string Code(this CaptureKind kind) => kind.ToString().ToLowerInvariant();
    public static string Code(this RecognitionMethod method) => method switch
    {
        RecognitionMethod.Embeddings => "embeddings",
        RecognitionMethod.OcrTop5 => "ocr-top5",
        RecognitionMethod.OcrAll => "ocr-all",
        _ => throw new ArgumentOutOfRangeException(nameof(method)),
    };
    public static string Code(this Finish finish) => finish.ToString().ToLowerInvariant();
    public static string Code(this Condition condition) => condition.ToString();
    public static string Code(this Currency currency) => currency.ToString().ToLowerInvariant();

    // Stored codes are always known ones; Scryfall's finishes can include one Deckino doesn't, which is left out.
    public static T Parse<T>(string code) where T : struct, Enum => Enum.Parse<T>(code, ignoreCase: true);
    public static Finish[] Finishes(string[] codes) =>
        [.. codes.Select(c => Enum.TryParse<Finish>(c, ignoreCase: true, out var finish) ? finish : (Finish?)null).OfType<Finish>()];
}
