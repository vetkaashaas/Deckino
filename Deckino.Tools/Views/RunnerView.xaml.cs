using System.Windows;
using System.Windows.Controls;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Views;

public partial class RunnerView : UserControl
{
    public RunnerView()
    {
        InitializeComponent();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (DataContext is RunnerViewModel viewModel)
        {
            await viewModel.EnsureQuickRequirementsCheckAsync();
        }
    }
}
