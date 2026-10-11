using Deckino.Toolbox.Controls;

namespace Deckino.Toolbox.Views;

public partial class SyncView : ContentView
{
    public SyncView()
    {
        InitializeComponent();
        Responsive.Watch(this, Responsive.Tight, tight =>
            Responsive.SetColumns(Body, tight ? 360 : 460, GridLength.Star));
    }
}
