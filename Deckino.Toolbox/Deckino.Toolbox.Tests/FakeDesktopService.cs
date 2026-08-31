using Deckino.Toolbox.Platform;

namespace Deckino.Toolbox.Tests;

internal sealed class FakeDesktopService : IDesktopService
{
    public Task<string?> PickFileAsync(string title, IReadOnlyList<string> extensions) => Task.FromResult<string?>(null);
    public Task<string?> PickFolderAsync(string title) => Task.FromResult<string?>(null);
    public Task<bool> ConfirmAsync(string title, string message, string accept = "Continue", string cancel = "Cancel") => Task.FromResult(false);
    public Task ShowMessageAsync(string title, string message, string close = "Close") => Task.CompletedTask;
    public Task CopyTextAsync(string text) => Task.CompletedTask;
    public void OpenFolder(string path) { }
    public void BeginInvoke(Action action) => action();
}
