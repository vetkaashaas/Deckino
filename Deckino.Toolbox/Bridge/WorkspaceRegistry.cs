using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Bridge;

/// <summary>What the UI can address by name: "app" (dialogs, toasts), "shell" and each workspace by its key.</summary>
public sealed class WorkspaceRegistry(ShellViewModel shell, AppEvents app)
{
    public object? Find(string name) => name switch
    {
        "app" => app,
        "shell" => shell,
        _ => shell.Workspaces.FirstOrDefault(workspace => string.Equals(workspace.Key, name, StringComparison.OrdinalIgnoreCase)),
    };

    /// <summary>The state the event stream sends: only the open page among the workspaces.</summary>
    public IEnumerable<string> Watched => ["app", "shell", shell.CurrentPage.Key];
}
