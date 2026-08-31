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
        string cancel = "Cancel") => Page().DisplayAlertAsync(title, message, accept, cancel);

    public Task ShowMessageAsync(string title, string message, string close = "Close") =>
        Page().DisplayAlertAsync(title, message, close);

    public Task CopyTextAsync(string text) => Clipboard.Default.SetTextAsync(text);

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
