using Deckino.Toolbox.Controls;

namespace Deckino.Toolbox.Views;

public partial class SyncView : ContentView
{
    public SyncView()
    {
        InitializeComponent();
        Responsive.Watch(this, Responsive.Stack, stacked => TwoColumnLayout.Apply(Panels, CoverageCard, stacked));
    }
}
