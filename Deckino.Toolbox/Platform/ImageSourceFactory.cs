using System.Drawing;
using System.Drawing.Imaging;

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
