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
        PhotoLibraryViewModel photoLibrary,
        ExtractionTrainingViewModel extractionTraining,
        RunnerViewModel runner)
    {
        Workspaces = [sync, annotator, photoLibrary, extractionTraining, runner];
        CurrentPage = sync;
    }

    partial void OnCurrentPageChanged(WorkspaceViewModel value)
    {
        if (value is IRefreshableWorkspace refreshable) _ = refreshable.RefreshAsync();
    }
}
