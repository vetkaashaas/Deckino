namespace Deckino.Tools.ViewModels;

public sealed record ExtractionStageItem(
    string Number,
    string Title,
    string Detail,
    string State);

public sealed class ExtractionTrainingViewModel : WorkspaceViewModel
{
    public override string DisplayName => "Card Extraction";

    public override string Description =>
        "Prepare, train, evaluate, and export the four-corner model that straightens camera frames before card recognition.";

    public string DatasetVersion => "corners-v1";

    public string ModelVersion => "extractor-mnv3-192-v1";

    public string Status => "Waiting for the versioned four-corner dataset and extraction training CLI.";

    public IReadOnlyList<ExtractionStageItem> Stages { get; } =
    [
        new("01", "Import and annotate", "Review existing corner labels and add difficult real-camera scenes.", "NEXT"),
        new("02", "Prepare dataset", "Validate ordered corners and create grouped train and validation splits.", "LOCKED"),
        new("03", "Run CUDA smoke", "Verify the 192 px keypoint network, AMP, and target batch size.", "LOCKED"),
        new("04", "Train or resume", "Fit four normalized corners and card-presence confidence.", "LOCKED"),
        new("05", "Evaluate geometry", "Measure corner error, valid warps, negative scenes, and camera conditions.", "LOCKED"),
        new("06", "Export extractor", "Package the checkpoint, thresholds, reports, ONNX, and int8 TFLite model.", "LOCKED"),
    ];
}
