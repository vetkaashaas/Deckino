using System.Drawing;
using System.Drawing.Imaging;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Bridge;

/// <summary>
/// Image URLs for the view models' state. Files are served from the data root only; a URL carries the file's
/// version (card art aside), so the browser caches it until the file changes. Bitmaps made in memory (perspective
/// previews, crops) are kept briefly and served by id.
/// </summary>
public static class Images
{
    private const int GeneratedKept = 48;
    private static readonly LinkedList<(string Id, byte[] Jpeg)> Generated = new();
    private static readonly ImageCodecInfo Jpeg = ImageCodecInfo.GetImageEncoders().First(codec => codec.FormatID == ImageFormat.Jpeg.Guid);

    public static string? File(string? path) =>
        string.IsNullOrWhiteSpace(path) || !System.IO.File.Exists(path)
            ? null
            : $"/api/files?path={Uri.EscapeDataString(path)}&v={System.IO.File.GetLastWriteTimeUtc(path).Ticks}";

    public static string Thumbnail(CameraPhoto photo) =>
        $"/api/thumbnails?path={Uri.EscapeDataString(photo.ImagePath)}&v={photo.ModifiedUtc.Ticks}-{photo.FileLength}";

    /// <summary>
    /// A cached full-card image cut to the phone's recognition box: the art a person picks a printing by. Made without
    /// touching the disk (a basic land lists hundreds of printings); a card image not downloaded yet is a 404.
    /// </summary>
    public static string? CardArt(string? path) =>
        string.IsNullOrWhiteSpace(path) ? null : $"/api/card-art?path={Uri.EscapeDataString(path)}";

    /// <summary>Encodes and disposes the bitmap.</summary>
    public static string FromBitmap(Bitmap bitmap)
    {
        byte[] bytes;
        using (bitmap) bytes = EncodeJpeg(bitmap);
        var id = Guid.NewGuid().ToString("N");
        lock (Generated)
        {
            Generated.AddFirst((id, bytes));
            while (Generated.Count > GeneratedKept) Generated.RemoveLast();
        }
        return $"/api/images/{id}";
    }

    public static byte[]? FindGenerated(string id)
    {
        lock (Generated) return Generated.FirstOrDefault(item => item.Id == id).Jpeg;
    }

    public static byte[] CropCardArt(string path)
    {
        using var source = new MemoryStream(System.IO.File.ReadAllBytes(path), writable: false);
        using var card = new Bitmap(source);
        double scaleX = card.Width / (double)RecognitionCrop.CardWidth, scaleY = card.Height / (double)RecognitionCrop.CardHeight;
        var box = Rectangle.FromLTRB(
            (int)Math.Round(RecognitionCrop.Left * scaleX), (int)Math.Round(RecognitionCrop.Top * scaleY),
            (int)Math.Round(RecognitionCrop.Right * scaleX), (int)Math.Round(RecognitionCrop.Bottom * scaleY));
        using var art = card.Clone(box, card.PixelFormat);
        return EncodeJpeg(art);
    }

    private static byte[] EncodeJpeg(Image image)
    {
        using var output = new MemoryStream();
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
        image.Save(output, Jpeg, parameters);
        return output.ToArray();
    }
}
