using CommunityToolkit.Mvvm.ComponentModel;

namespace Deckino.Toolbox.ViewModels;

public abstract class WorkspaceViewModel : ObservableObject
{
    public abstract string DisplayName { get; }
    public abstract string Description { get; }

    /// <summary>The page's name in the bridge and the UI: the type name without "ViewModel", camelCase.</summary>
    public string Key
    {
        get
        {
            var name = GetType().Name.Replace("ViewModel", string.Empty);
            return char.ToLowerInvariant(name[0]) + name[1..];
        }
    }
}

public interface IRefreshableWorkspace
{
    Task RefreshAsync();
}

/// <summary>A status pill's colour.</summary>
public enum StatusTone
{
    Neutral,
    Pending,
    Accent,
    Success,
    Warning,
    Danger,
}
