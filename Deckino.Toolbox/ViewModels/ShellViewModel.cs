using CommunityToolkit.Mvvm.ComponentModel;

namespace Deckino.Toolbox.ViewModels;

public partial class ShellViewModel : ObservableObject
{
    public IReadOnlyList<WorkspaceViewModel> Workspaces { get; }

    [ObservableProperty]
    public partial WorkspaceViewModel CurrentPage { get; set; }

    public ShellViewModel(
        SyncViewModel sync,
        DatasetSyncViewModel datasetSync,
        VideoImportViewModel videoImport,
        AnnotatorViewModel annotator,
        PhotoLibraryViewModel photoLibrary,
        ExtractionTrainingViewModel extractionTraining,
        RunnerViewModel runner)
    {
        Workspaces = [sync, datasetSync, videoImport, annotator, photoLibrary, extractionTraining, runner];
        CurrentPage = sync;
    }

    partial void OnCurrentPageChanged(WorkspaceViewModel value)
    {
        if (value is IRefreshableWorkspace refreshable) _ = refreshable.RefreshAsync();
    }
}
