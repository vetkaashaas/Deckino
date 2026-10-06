using Deckino.Toolbox.Controls;
using Microsoft.Maui.Graphics;

namespace Deckino.Toolbox.Tests;

public sealed class AnnotationCanvasTransformTests
{
    [Theory]
    [InlineData(1, 0, 0)]
    [InlineData(2.5, 120, -80)]
    [InlineData(8, -900, 480)]
    public void ViewportAndBaseTransformsRoundTrip(double zoom, double translationX, double translationY)
    {
        var source = new Point(317.25, 202.75);

        var viewport = AnnotationCanvas.BaseToViewport(
            source, zoom, translationX, translationY, 1200, 800);
        var actual = AnnotationCanvas.ViewportToBase(
            viewport, zoom, translationX, translationY, 1200, 800);

        Assert.Equal(source.X, actual.X, 10);
        Assert.Equal(source.Y, actual.Y, 10);
    }

    [Fact]
    public void CursorCenteredZoomKeepsTheSameImageCoordinateUnderThePointer()
    {
        var focalPoint = new Point(830, 270);
        var imagePointBefore = AnnotationCanvas.ViewportToBase(
            focalPoint, 1.8, 75, -20, 1200, 800);

        var translation = AnnotationCanvas.CalculateZoomTranslation(
            focalPoint, 1.8, 3.2, 75, -20, 1200, 800);
        var imagePointAfter = AnnotationCanvas.ViewportToBase(
            focalPoint, 3.2, translation.X, translation.Y, 1200, 800);

        Assert.Equal(imagePointBefore.X, imagePointAfter.X, 10);
        Assert.Equal(imagePointBefore.Y, imagePointAfter.Y, 10);
    }
}
