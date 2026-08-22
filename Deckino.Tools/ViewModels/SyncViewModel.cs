namespace Deckino.Tools.ViewModels;

public sealed class SyncViewModel : WorkspaceViewModel
{
    public override string DisplayName => "Scryfall Sync";
    public override string Description =>
        "Download Scryfall bulk data and art crops into the local cache. Not wired up yet.";
}
