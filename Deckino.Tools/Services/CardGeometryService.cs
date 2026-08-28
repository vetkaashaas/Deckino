using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Deckino.Tools.Services;

public sealed record GeometryValidation(bool IsValid, string Message);

public static class CardGeometryService
{
    public const int PreviewWidth = 315;
    public const int PreviewHeight = 440;

    public static GeometryValidation Validate(IReadOnlyList<NormalizedPoint> points)
    {
        if (points.Count != 4) return new(false, "Add all four corners in order.");
        if (points.Any(point => point.X is < 0 or > 1 || point.Y is < 0 or > 1))
            return new(false, "Every corner must remain inside the photograph.");
        for (var first = 0; first < points.Count; first++)
            for (var second = first + 1; second < points.Count; second++)
            {
                if (DistanceSquared(points[first], points[second]) < 0.000025)
                    return new(false, "Two corners are too close together.");
            }

        var signs = new List<double>(4);
        for (var index = 0; index < 4; index++)
        {
            var a = points[index];
            var b = points[(index + 1) % 4];
            var c = points[(index + 2) % 4];
            signs.Add(Cross(a, b, c));
        }
        if (signs.Any(value => Math.Abs(value) < 0.0001) ||
            !(signs.All(value => value > 0) || signs.All(value => value < 0)))
            return new(false, "The ordered corners must form a convex, non-crossing card outline.");

        var area = Math.Abs(points.Select((point, index) =>
            point.X * points[(index + 1) % 4].Y - points[(index + 1) % 4].X * point.Y).Sum()) / 2;
        if (area < 0.0025) return new(false, "The selected card area is too small.");
        return new(true, "Geometry is valid and ready to save.");
    }

    public static BitmapSource CreatePerspectivePreview(BitmapSource image, IReadOnlyList<NormalizedPoint> points)
    {
        var validation = Validate(points);
        if (!validation.IsValid) throw new ArgumentException(validation.Message, nameof(points));

        var source = new FormatConvertedBitmap(image, PixelFormats.Bgra32, null, 0);
        var sourceStride = source.PixelWidth * 4;
        var sourcePixels = new byte[sourceStride * source.PixelHeight];
        source.CopyPixels(sourcePixels, sourceStride, 0);

        var pixelCorners = points.Select(point => new NormalizedPoint(
            point.X * (source.PixelWidth - 1),
            point.Y * (source.PixelHeight - 1))).ToArray();
        var destinationCorners = new[]
        {
            new NormalizedPoint(0, 0),
            new NormalizedPoint(PreviewWidth - 1, 0),
            new NormalizedPoint(PreviewWidth - 1, PreviewHeight - 1),
            new NormalizedPoint(0, PreviewHeight - 1),
        };
        var homography = SolveHomography(destinationCorners, pixelCorners);
        var outputStride = PreviewWidth * 4;
        var output = new byte[outputStride * PreviewHeight];
        for (var y = 0; y < PreviewHeight; y++)
            for (var x = 0; x < PreviewWidth; x++)
            {
                var denominator = homography[6] * x + homography[7] * y + 1;
                var sourceX = (homography[0] * x + homography[1] * y + homography[2]) / denominator;
                var sourceY = (homography[3] * x + homography[4] * y + homography[5]) / denominator;
                SampleBilinear(sourcePixels, source.PixelWidth, source.PixelHeight, sourceStride,
                    sourceX, sourceY, output, y * outputStride + x * 4);
            }
        var preview = BitmapSource.Create(PreviewWidth, PreviewHeight, 96, 96,
            PixelFormats.Bgra32, null, output, outputStride);
        preview.Freeze();
        return preview;
    }

    internal static double[] SolveHomography(
        IReadOnlyList<NormalizedPoint> from,
        IReadOnlyList<NormalizedPoint> to)
    {
        var matrix = new double[8, 9];
        for (var index = 0; index < 4; index++)
        {
            var x = from[index].X;
            var y = from[index].Y;
            var u = to[index].X;
            var v = to[index].Y;
            var row = index * 2;
            matrix[row, 0] = x; matrix[row, 1] = y; matrix[row, 2] = 1;
            matrix[row, 6] = -u * x; matrix[row, 7] = -u * y; matrix[row, 8] = u;
            matrix[row + 1, 3] = x; matrix[row + 1, 4] = y; matrix[row + 1, 5] = 1;
            matrix[row + 1, 6] = -v * x; matrix[row + 1, 7] = -v * y; matrix[row + 1, 8] = v;
        }

        for (var pivot = 0; pivot < 8; pivot++)
        {
            var best = Enumerable.Range(pivot, 8 - pivot)
                .MaxBy(row => Math.Abs(matrix[row, pivot]));
            if (Math.Abs(matrix[best, pivot]) < 1e-10) throw new InvalidOperationException("The corners cannot produce a perspective transform.");
            if (best != pivot)
                for (var column = pivot; column < 9; column++)
                    (matrix[pivot, column], matrix[best, column]) = (matrix[best, column], matrix[pivot, column]);
            var divisor = matrix[pivot, pivot];
            for (var column = pivot; column < 9; column++) matrix[pivot, column] /= divisor;
            for (var row = 0; row < 8; row++)
            {
                if (row == pivot) continue;
                var factor = matrix[row, pivot];
                for (var column = pivot; column < 9; column++) matrix[row, column] -= factor * matrix[pivot, column];
            }
        }
        return Enumerable.Range(0, 8).Select(row => matrix[row, 8]).ToArray();
    }

    private static void SampleBilinear(
        byte[] source, int width, int height, int stride,
        double x, double y, byte[] destination, int destinationOffset)
    {
        x = Math.Clamp(x, 0, width - 1);
        y = Math.Clamp(y, 0, height - 1);
        var x0 = (int)Math.Floor(x);
        var y0 = (int)Math.Floor(y);
        var x1 = Math.Min(x0 + 1, width - 1);
        var y1 = Math.Min(y0 + 1, height - 1);
        var xWeight = x - x0;
        var yWeight = y - y0;
        for (var channel = 0; channel < 4; channel++)
        {
            var top = source[y0 * stride + x0 * 4 + channel] * (1 - xWeight)
                      + source[y0 * stride + x1 * 4 + channel] * xWeight;
            var bottom = source[y1 * stride + x0 * 4 + channel] * (1 - xWeight)
                         + source[y1 * stride + x1 * 4 + channel] * xWeight;
            destination[destinationOffset + channel] = (byte)Math.Clamp(
                Math.Round(top * (1 - yWeight) + bottom * yWeight), 0, 255);
        }
    }

    private static double DistanceSquared(NormalizedPoint first, NormalizedPoint second) =>
        Math.Pow(first.X - second.X, 2) + Math.Pow(first.Y - second.Y, 2);

    private static double Cross(NormalizedPoint a, NormalizedPoint b, NormalizedPoint c) =>
        (b.X - a.X) * (c.Y - b.Y) - (b.Y - a.Y) * (c.X - b.X);
}
