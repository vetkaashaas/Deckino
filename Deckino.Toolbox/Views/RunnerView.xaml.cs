using Deckino.Toolbox.Controls;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Views;

public partial class RunnerView : ContentView
{
    public RunnerView()
    {
        InitializeComponent();
        Responsive.Watch(this, Responsive.Tight, tight =>
            Responsive.SetColumns(Columns, tight ? 340 : 420, GridLength.Star));
        Loaded += async (_, _) =>
        {
            if (BindingContext is RunnerViewModel viewModel) await viewModel.EnsureQuickRequirementsCheckAsync();
        };
    }

    private void OnToggleChecklist(object? sender, EventArgs e)
    {
        if (BindingContext is RunnerViewModel viewModel)
            viewModel.ShowRequirementDetails = !viewModel.ShowRequirementDetails;
    }
}
