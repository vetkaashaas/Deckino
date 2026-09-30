using Deckino.Toolbox.Controls;

namespace Deckino.Toolbox.Views;

public partial class VideoImportView : ContentView
{
    public VideoImportView()
    {
        InitializeComponent();
        Responsive.Watch(this, Responsive.Tight, tight =>
            Responsive.SetColumns(Columns, tight ? 320 : 400, GridLength.Star));
    }
}
