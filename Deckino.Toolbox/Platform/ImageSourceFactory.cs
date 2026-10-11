using System.Drawing;
using System.Drawing.Imaging;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Platform;

public static class ImageSourceFactory
{
    internal static byte[] ReadAllBytesUnlocked(string path) => File.ReadAllBytes(path);

    public static ImageSource FromFileUnlocked(string path)
    {
        return FromBytesUnlocked(ReadAllBytesUnlocked(path));
    }

    public static ImageSource FromBytesUnlocked(byte[] bytes) =>
        ImageSource.FromStream(() => new MemoryStream(bytes, writable: false));

    // A cached full-card image shown through the phone's recognition box looks like the art the model compares,
    // which is what a person picks a card or printing by.
    // Decoded when the image is first shown, so a long list of printings stays cheap.
    public static ImageSource FromCardArtBox(string path) => ImageSource.FromStream(() => CropArtBox(path));

    private static Stream CropArtBox(string path)
    {
        using var source = new MemoryStream(ReadAllBytesUnlocked(path), writable: false);
        using var card = new Bitmap(source);
        double scaleX = card.Width / (double)RecognitionCrop.CardWidth, scaleY = card.Height / (double)RecognitionCrop.CardHeight;
        var box = Rectangle.FromLTRB(
            (int)Math.Round(RecognitionCrop.Left * scaleX), (int)Math.Round(RecognitionCrop.Top * scaleY),
            (int)Math.Round(RecognitionCrop.Right * scaleX), (int)Math.Round(RecognitionCrop.Bottom * scaleY));
        using var art = card.Clone(box, card.PixelFormat);
        var output = new MemoryStream();
        art.Save(output, System.Drawing.Imaging.ImageFormat.Jpeg);
        output.Position = 0;
        return output;
    }

    public static ImageSource FromBitmap(Bitmap bitmap)
    {
        using (bitmap)
        using (var stream = new MemoryStream())
        {
            bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
            var bytes = stream.ToArray();
            return ImageSource.FromStream(() => new MemoryStream(bytes, writable: false));
        }
    }
}
