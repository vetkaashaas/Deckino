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
#if WINDOWS
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
#endif
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
