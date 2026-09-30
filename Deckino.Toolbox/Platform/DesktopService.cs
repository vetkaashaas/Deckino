using System.Diagnostics;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Storage;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace Deckino.Toolbox.Platform;

public sealed class DesktopService : IDesktopService
{
    public async Task<string?> PickFileAsync(
        string title,
        IReadOnlyList<string> extensions)
    {
        var result = await FilePicker.Default.PickAsync(new PickOptions
        {
            PickerTitle = title,
            FileTypes = new FilePickerFileType(new Dictionary<DevicePlatform, IEnumerable<string>>
            {
                [DevicePlatform.WinUI] = extensions,
            }),
        });
        return result?.FullPath;
    }

    public async Task<string?> PickFolderAsync(string title)
    {
        var picker = new FolderPicker
        {
            SuggestedStartLocation = PickerLocationId.PicturesLibrary,
            ViewMode = PickerViewMode.Thumbnail,
        };
        picker.FileTypeFilter.Add("*");
        if (Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()?.Handler?.PlatformView
            is Microsoft.UI.Xaml.Window window)
        {
            InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(window));
        }
        var result = await picker.PickSingleFolderAsync();
        return result?.Path;
    }

    public Task<bool> ConfirmAsync(
        string title,
        string message,
        string accept = "Continue",
        string cancel = "Cancel") => MainThread.InvokeOnMainThreadAsync(() => Page() is AppShell shell
            ? shell.Overlay.ShowDialogAsync(title, message, accept, cancel)
            : Page().DisplayAlertAsync(title, message, accept, cancel));

    public Task ShowMessageAsync(string title, string message, string close = "Close") =>
        MainThread.InvokeOnMainThreadAsync(() => Page() is AppShell shell
            ? shell.Overlay.ShowDialogAsync(title, message, close, cancel: null)
            : Page().DisplayAlertAsync(title, message, close));

    public async Task CopyTextAsync(string text)
    {
        await Clipboard.Default.SetTextAsync(text);
        MainThread.BeginInvokeOnMainThread(() =>
        {
            if (Page() is AppShell shell) shell.Overlay.ShowToast("Copied to clipboard");
        });
    }

    public void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    public void BeginInvoke(Action action) => MainThread.BeginInvokeOnMainThread(action);

    private static Page Page() =>
        Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()?.Page
        ?? throw new InvalidOperationException("The application window is not ready.");
}
