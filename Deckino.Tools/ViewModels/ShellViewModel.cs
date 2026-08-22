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
        RunnerViewModel runner)
    {
        Workspaces = [sync, annotator, runner];
        CurrentPage = sync;
    }
}
