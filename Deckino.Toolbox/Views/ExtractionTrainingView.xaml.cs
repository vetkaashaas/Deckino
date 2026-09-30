using Deckino.Toolbox.Controls;

namespace Deckino.Toolbox.Views;

public partial class ExtractionTrainingView : ContentView
{
    public ExtractionTrainingView()
    {
        InitializeComponent();
        Responsive.Watch(this, Responsive.Tight, tight =>
            Responsive.SetColumns(TrainPane, tight ? 340 : 420, GridLength.Star));
    }

    private void OnTabChanged(object? sender, EventArgs e)
    {
        var diagnostic = Tabs.Selected == "Diagnostic";
        TrainPane.IsVisible = !diagnostic;
        DiagnosticPane.IsVisible = diagnostic;
    }
}
