using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Views;

public partial class ExtractionTrainingView : ContentView
{
    public ExtractionTrainingView()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            if (BindingContext is ExtractionTrainingViewModel viewModel) await viewModel.RefreshAsync();
        };
    }
}
