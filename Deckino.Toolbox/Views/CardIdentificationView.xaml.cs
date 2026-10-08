#if WINDOWS
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;
#endif
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Views;

public partial class CardIdentificationView : ContentView
{
#if WINDOWS
    private UIElement? _keyboardHost;
#endif

    public CardIdentificationView()
    {
        InitializeComponent();
#if WINDOWS
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
#endif
    }

    private void ChoiceTapped(object? sender, TappedEventArgs e)
    {
        if (sender is BindableObject { BindingContext: CardChoiceViewModel choice }
            && BindingContext is CardIdentificationViewModel viewModel)
            viewModel.SelectCommand.Execute(choice);
    }

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

    // Enter saves, ← → browse; not while typing a search.
    private void OnKeyboardHostKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key is not (VirtualKey.Left or VirtualKey.Right or VirtualKey.Enter)
            // A held Enter would save photo after photo without them being looked at.
            || (e.Key == VirtualKey.Enter && e.KeyStatus.WasKeyDown)
            || Controls.OverlayHost.IsDialogOpen
            || BindingContext is not CardIdentificationViewModel viewModel
            || FocusManager.GetFocusedElement(_keyboardHost?.XamlRoot) is var focused
                && (focused is TextBox or PasswordBox or RichEditBox
                    // A focused button answers Enter itself; handling it here too would run two actions.
                    || (e.Key == VirtualKey.Enter && focused is Microsoft.UI.Xaml.Controls.Primitives.ButtonBase)))
            return;

        var command = e.Key switch
        {
            VirtualKey.Right => viewModel.MoveNextCommand,
            VirtualKey.Left => viewModel.MovePreviousCommand,
            _ => viewModel.ConfirmCommand,
        };
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
