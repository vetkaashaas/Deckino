using System.Text.Json.Serialization;

namespace Deckino.Toolbox.Services;

public sealed record NormalizedPoint(double X, double Y);

public sealed class CardAnnotation
{
    public int SchemaVersion { get; init; } = 1;
    public string DatasetVersion { get; init; } = "corners-v1";
    public required string ImageFile { get; init; }
    public bool CardPresent { get; init; } = true;
    public IReadOnlyList<string> CornerOrder { get; init; } = CameraAnnotationStore.CornerOrder;
    public NormalizedPoint? TopLeft { get; init; }
    public NormalizedPoint? TopRight { get; init; }
    public NormalizedPoint? BottomRight { get; init; }
    public NormalizedPoint? BottomLeft { get; init; }
    public int ImageWidth { get; init; }
    public int ImageHeight { get; init; }
    public string SourceGroup { get; init; } = string.Empty;
    public string? CaptureCondition { get; init; }
    public string? Split { get; init; }
    // Which corner definition the annotator followed; null for positives saved before it was recorded.
    public string? CornerConvention { get; init; }

    [JsonIgnore]
    public IReadOnlyList<NormalizedPoint?> Points => [TopLeft, TopRight, BottomRight, BottomLeft];
}

// The card shown in a camera photo, next to it as <photo>._identity.json. Phone uploads (Source "phone") carry
// the app's corners and recognizer candidates; "Suggest cards" adds candidates for photos without one (Source
// "toolbox"). Only Status confirmed/corrected with OracleId set is a label; the Predicted*/Candidates fields are
// model guesses and must never be trained on.
public sealed class CardIdentity
{
    public int SchemaVersion { get; init; } = 1;
    public required string ImageFile { get; init; }
    public string Source { get; init; } = "toolbox";
    public DateTimeOffset? CapturedUtc { get; init; }
    public string? Kind { get; init; }
    public string? ModelVersion { get; init; }
    public string? ExtractorVersion { get; init; }
    public IReadOnlyList<NormalizedPoint>? PredictedCorners { get; init; }
    public IReadOnlyList<IdentityCandidate> Candidates { get; init; } = [];
    public string? PredictedOracleId { get; init; }
    public string Status { get; init; } = CardIdentityStatus.Unreviewed;
    public string? OracleId { get; init; }
    public DateTimeOffset? ReviewedUtc { get; init; }
}

public sealed record IdentityCandidate(string OracleId, double Score, int Prototype);

public static class CardIdentityStatus
{
    public const string Unreviewed = "unreviewed";
    public const string Confirmed = "confirmed";
    public const string Corrected = "corrected";
    public const string NotACard = "not_a_card";
    public const string Unreadable = "unreadable";
    public static readonly IReadOnlySet<string> All = new HashSet<string>
        { Unreviewed, Confirmed, Corrected, NotACard, Unreadable };
}

public sealed record CameraImportSource(
    string SourceFolder,
    string ImportedFolder,
    string SourceGroup);

public sealed record CameraImportDescriptor(
    int SchemaVersion,
    string BatchId,
    DateTimeOffset CreatedUtc,
    string? CaptureCondition,
    IReadOnlyList<CameraImportSource> Sources)
{
    public VideoImportMetadata? Video { get; init; }
}

public sealed record VideoImportMetadata(
    string SourcePath,
    double DurationSeconds,
    double SourceFramesPerSecond,
    double RequestedFramesPerSecond,
    double EffectiveFramesPerSecond,
    int ExtractedFrames);

public sealed record CameraPhoto(
    string ImagePath,
    string RelativePath,
    string AnnotationPath,
    string SourceGroup,
    string? CaptureCondition,
    int ImageWidth,
    int ImageHeight,
    bool IsAnnotated,
    bool HasInvalidAnnotation,
    DateTime ModifiedUtc = default,
    long FileLength = 0)
{
    public string IdentityPath => CameraAnnotationStore.IdentityPathFor(ImagePath);
}

public sealed record CameraImportResult(
    string BatchRoot,
    int Imported,
    int Skipped,
    int Failed,
    IReadOnlyList<string> Errors);

public sealed record CameraDeleteResult(
    int DeletedPhotos,
    int DeletedAnnotations,
    IReadOnlyList<string> Errors);
