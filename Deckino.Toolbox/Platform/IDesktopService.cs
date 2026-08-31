namespace Deckino.Toolbox.Platform;

public interface IDesktopService
{
    Task<string?> PickFileAsync(string title, IReadOnlyList<string> extensions);
    Task<string?> PickFolderAsync(string title);
    Task<bool> ConfirmAsync(string title, string message, string accept = "Continue", string cancel = "Cancel");
    Task ShowMessageAsync(string title, string message, string close = "Close");
    Task CopyTextAsync(string text);
    void OpenFolder(string path);
    void BeginInvoke(Action action);
}
