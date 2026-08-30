using System.Text.Json.Serialization;

namespace Deckino.Tools.Services;

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

    [JsonIgnore]
    public IReadOnlyList<NormalizedPoint?> Points => [TopLeft, TopRight, BottomRight, BottomLeft];
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
    bool HasInvalidAnnotation);

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
