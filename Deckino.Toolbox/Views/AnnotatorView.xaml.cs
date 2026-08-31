namespace Deckino.Toolbox.Views;

public partial class AnnotatorView : ContentView
{
    public AnnotatorView() => InitializeComponent();

    private void ZoomInClicked(object? sender, EventArgs e) => Canvas.ZoomIn();
    private void ZoomOutClicked(object? sender, EventArgs e) => Canvas.ZoomOut();
    private void ResetZoomClicked(object? sender, EventArgs e) => Canvas.ResetView();
}
