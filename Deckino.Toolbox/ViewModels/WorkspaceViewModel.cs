using CommunityToolkit.Mvvm.ComponentModel;

namespace Deckino.Toolbox.ViewModels;

public abstract class WorkspaceViewModel : ObservableObject
{
    public abstract string DisplayName { get; }
    public abstract string Description { get; }
}

public interface IRefreshableWorkspace
{
    Task RefreshAsync();
}
