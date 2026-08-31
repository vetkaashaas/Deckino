using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox;

public partial class AppShell : ContentPage
{
    public AppShell(ShellViewModel viewModel)
    {
        InitializeComponent();
        BindingContext = viewModel;
    }

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        Opacity = 0;
        TranslationY = 8;
        await Task.WhenAll(this.FadeToAsync(1, 180, Easing.CubicOut), this.TranslateToAsync(0, 0, 180, Easing.CubicOut));
    }
}
