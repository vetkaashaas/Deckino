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
        CardIdentificationViewModel cardIdentification,
        PhotoLibraryViewModel photoLibrary,
        ExtractionTrainingViewModel extractionTraining,
        RunnerViewModel runner,
        ModelBenchmarksViewModel modelBenchmarks)
    {
        Workspaces = [sync, datasetSync, videoImport, annotator, cardIdentification, photoLibrary, extractionTraining, runner,
            modelBenchmarks];
        CurrentPage = sync;
    }

    partial void OnCurrentPageChanged(WorkspaceViewModel value)
    {
        if (value is IRefreshableWorkspace refreshable) _ = refreshable.RefreshAsync();
    }
}
