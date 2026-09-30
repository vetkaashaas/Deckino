#if WINDOWS
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Windows.System;
#endif

namespace Deckino.Toolbox.Controls;

/// <summary>
/// In-window replacement for system alert popups: one themed dialog at a time over a scrim,
/// plus short toasts. Lives as the top layer of the shell.
/// </summary>
public partial class OverlayHost : ContentView
{
    private readonly SemaphoreSlim _dialogGate = new(1, 1);
    private TaskCompletionSource<bool>? _pending;
    private int _toastVersion;
#if WINDOWS
    private FrameworkElement? _keyboardCard;
#endif

    public OverlayHost()
    {
        InitializeComponent();
#if WINDOWS
        DialogCard.HandlerChanged += (_, _) => AttachKeyboard();
#endif
    }

    /// <summary>True while a dialog is up, so window-level shortcuts can stand down.</summary>
    public static bool IsDialogOpen { get; private set; }

    /// <summary>Shows a dialog and waits for the answer. A null cancel caption shows a single button.</summary>
    public async Task<bool> ShowDialogAsync(string title, string message, string accept, string? cancel)
    {
        await _dialogGate.WaitAsync();
        try
        {
            _pending = new TaskCompletionSource<bool>();
            DialogTitle.Text = title;
            DialogMessage.Text = message;
            AcceptButton.Text = accept;
            CancelButton.Text = cancel ?? string.Empty;
            CancelButton.IsVisible = cancel is not null;

            IsDialogOpen = true;
            DialogLayer.Opacity = 0;
            DialogCard.Scale = 0.97;
            DialogLayer.IsVisible = true;
            IsVisible = true;
            await Task.WhenAll(
                DialogLayer.FadeToAsync(1, 120, Easing.CubicOut),
                DialogCard.ScaleToAsync(1, 120, Easing.CubicOut));
            AcceptButton.Focus();

            var result = await _pending.Task;

            await DialogLayer.FadeToAsync(0, 90, Easing.CubicIn);
            DialogLayer.IsVisible = false;
            IsVisible = Toast.IsVisible;
            return result;
        }
        finally
        {
            IsDialogOpen = false;
            _pending = null;
            _dialogGate.Release();
        }
    }

    public async void ShowToast(string text)
    {
        var version = ++_toastVersion;
        ToastLabel.Text = text;
        Toast.IsVisible = true;
        IsVisible = true;
        await Toast.FadeToAsync(1, 120, Easing.CubicOut);
        await Task.Delay(1600);
        // A newer toast has taken over the label; let it own the fade-out.
        if (version != _toastVersion) return;
        await Toast.FadeToAsync(0, 200, Easing.CubicIn);
        if (version != _toastVersion) return;
        Toast.IsVisible = false;
        IsVisible = DialogLayer.IsVisible;
    }

    private void OnAcceptClicked(object? sender, EventArgs e) => _pending?.TrySetResult(true);

    private void OnCancelClicked(object? sender, EventArgs e) => _pending?.TrySetResult(false);

#if WINDOWS
    private void AttachKeyboard()
    {
        if (_keyboardCard is not null) _keyboardCard.KeyDown -= OnDialogKeyDown;
        _keyboardCard = DialogCard.Handler?.PlatformView as FrameworkElement;
        if (_keyboardCard is not { } card) return;
        // Tab stays inside the dialog instead of reaching the controls under the scrim.
        card.TabFocusNavigation = KeyboardNavigationMode.Cycle;
        card.KeyDown += OnDialogKeyDown;
    }

    private void OnDialogKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Escape)
        {
            // Escape declines; on a single-button message that simply closes it.
            _pending?.TrySetResult(!CancelButton.IsVisible);
            e.Handled = true;
            return;
        }
        // Keep everything except button activation and Tab away from window-level shortcuts.
        if (e.Key is not (VirtualKey.Tab or VirtualKey.Enter or VirtualKey.Space)) e.Handled = true;
    }
#endif
}
