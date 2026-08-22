namespace Deckino.Tools.ViewModels;

public sealed class AnnotatorViewModel : WorkspaceViewModel
{
    public override string DisplayName => "Corner Annotator";
    public override string Description =>
        "Annotate card corners to build detector ground truth and warp calibration. Not wired up yet.";
}
