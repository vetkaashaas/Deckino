#if WINDOWS
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;
#endif

namespace Deckino.Toolbox.Views;

public partial class AnnotatorView : ContentView
{
#if WINDOWS
    private UIElement? _keyboardHost;
#endif

    public AnnotatorView()
    {
        InitializeComponent();
        RailScroll.SizeChanged += (_, _) => FitPreview();
        GuidanceCard.SizeChanged += (_, _) => FitPreview();
#if WINDOWS
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
#endif
    }

    // The preview takes whatever height the rail has left under the guidance card, but never less
    // than a usable minimum; below that the rail scrolls instead of squeezing the preview away.
    private void FitPreview()
    {
        if (RailScroll.Height <= 0 || GuidanceCard.Height <= 0) return;
        const double railSpacing = 12;
        const double minimumPreviewHeight = 180;
        var height = Math.Max(minimumPreviewHeight, Math.Floor(RailScroll.Height - GuidanceCard.Height - railSpacing));
        if (Math.Abs(PreviewWell.HeightRequest - height) > 0.5) PreviewWell.HeightRequest = height;
    }

    private void ZoomInClicked(object? sender, EventArgs e) => Canvas.ZoomIn();
    private void ZoomOutClicked(object? sender, EventArgs e) => Canvas.ZoomOut();
    private void ResetZoomClicked(object? sender, EventArgs e) => Canvas.ResetView();

#if WINDOWS
    private void OnLoaded(object? sender, EventArgs e)
    {
        DetachKeyboardShortcut();
        if (Window?.Handler?.PlatformView is not Microsoft.UI.Xaml.Window nativeWindow
            || nativeWindow.Content is not UIElement keyboardHost)
            return;

        _keyboardHost = keyboardHost;
        _keyboardHost.KeyDown += OnKeyboardHostKeyDown;
    }

    private void OnUnloaded(object? sender, EventArgs e) => DetachKeyboardShortcut();

    private void OnKeyboardHostKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key is not (VirtualKey.Left or VirtualKey.Right)
            || Controls.OverlayHost.IsDialogOpen
            || BindingContext is not ViewModels.AnnotatorViewModel viewModel
            || FocusManager.GetFocusedElement(_keyboardHost?.XamlRoot) is TextBox or PasswordBox or RichEditBox)
            return;

        var command = e.Key == VirtualKey.Right
            ? viewModel.MoveNextCommand
            : viewModel.MovePreviousCommand;
        if (!command.CanExecute(null)) return;

        e.Handled = true;
        command.Execute(null);
    }

    private void DetachKeyboardShortcut()
    {
        if (_keyboardHost is not null)
            _keyboardHost.KeyDown -= OnKeyboardHostKeyDown;
        _keyboardHost = null;
    }
#endif
}
