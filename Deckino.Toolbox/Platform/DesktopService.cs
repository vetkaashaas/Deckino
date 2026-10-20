using System.Diagnostics;
using System.Windows.Forms;
using Deckino.Toolbox.Bridge;

namespace Deckino.Toolbox.Platform;

/// <summary>
/// Pickers are Windows' own dialogs over the window; confirmations, messages and toasts are shown by the React UI
/// (AppEvents). Every member runs on the UI thread, where the view models call it.
/// </summary>
public sealed class DesktopService(UiDispatcher ui, AppEvents events) : IDesktopService
{
    /// <summary>The window, once it exists; null with --serve.</summary>
    public Form? Window { get; set; }

    public async Task<string?> PickFileAsync(string title, IReadOnlyList<string> extensions)
    {
        // Let the command's HTTP call return before the modal dialog blocks this thread.
        await Task.Yield();
        var patterns = string.Join(";", extensions.Select(extension => "*" + extension));
        using var dialog = new OpenFileDialog
        {
            Title = title,
            Filter = $"{string.Join(", ", extensions)}|{patterns}|All files|*.*",
            CheckFileExists = true,
        };
        return dialog.ShowDialog(Window) == DialogResult.OK ? dialog.FileName : null;
    }

    public async Task<string?> PickFolderAsync(string title)
    {
        await Task.Yield();
        using var dialog = new FolderBrowserDialog
        {
            Description = title,
            UseDescriptionForTitle = true,
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
        };
        return dialog.ShowDialog(Window) == DialogResult.OK ? dialog.SelectedPath : null;
    }

    public Task<bool> ConfirmAsync(string title, string message, string accept = "Continue", string cancel = "Cancel") =>
        events.AskAsync(title, message, accept, cancel);

    public Task ShowMessageAsync(string title, string message, string close = "Close") =>
        events.AskAsync(title, message, close, cancel: null);

    public Task CopyTextAsync(string text)
    {
        Clipboard.SetText(text);
        events.Show("Copied to clipboard");
        return Task.CompletedTask;
    }

    public void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    public void BeginInvoke(Action action) => ui.Post(action);

    public void Quit()
    {
        if (Window is { } window) window.Close();
        else Application.ExitThread();
    }
}
