using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Views;

public partial class RunnerView : ContentView
{
    public RunnerView()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            if (BindingContext is RunnerViewModel viewModel) await viewModel.EnsureQuickRequirementsCheckAsync();
        };
    }
}
