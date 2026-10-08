using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Controls;

/// <summary>Sidebar presentation for each workspace: which group it sits in and its icon.</summary>
public static class WorkspaceChrome
{
    // Segoe Fluent Icons glyphs; every code also exists in Segoe MDL2 Assets.
    public static (string Group, string Glyph) For(WorkspaceViewModel workspace) => workspace switch
    {
        SyncViewModel => ("Data", ""),
        DatasetSyncViewModel => ("Data", ""),
        VideoImportViewModel => ("Capture", ""),
        AnnotatorViewModel => ("Capture", ""),
        CardIdentificationViewModel => ("Capture", ""),
        PhotoLibraryViewModel => ("Capture", ""),
        ExtractionTrainingViewModel => ("Models", ""),
        RunnerViewModel => ("Models", ""),
        _ => ("Workspaces", ""),
    };
}
