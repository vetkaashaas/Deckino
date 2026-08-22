namespace Deckino.Tools.ViewModels;

public sealed class RunnerViewModel : WorkspaceViewModel
{
    public override string DisplayName => "PythonRunner";
    public override string Description =>
        "Run training and export scripts with live log output. Not wired up yet.";
}
