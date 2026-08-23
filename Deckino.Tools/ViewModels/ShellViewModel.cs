using CommunityToolkit.Mvvm.ComponentModel;

namespace Deckino.Tools.ViewModels;

public partial class ShellViewModel : ObservableObject
{
    public IReadOnlyList<WorkspaceViewModel> Workspaces { get; }

    [ObservableProperty]
    public partial WorkspaceViewModel CurrentPage { get; set; }

    public ShellViewModel(
        SyncViewModel sync,
        AnnotatorViewModel annotator,
        ExtractionTrainingViewModel extractionTraining,
        RunnerViewModel runner)
    {
        Workspaces = [sync, annotator, extractionTraining, runner];
        CurrentPage = sync;
    }
}
