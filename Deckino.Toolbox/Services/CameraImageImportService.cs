using System.IO;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Text.Json;
using DrawingImage = System.Drawing.Image;
using DrawingImageFormat = System.Drawing.Imaging.ImageFormat;

namespace Deckino.Toolbox.Services;

public sealed class CameraImageImportService
{
    internal const int MaximumImportedShortSide = 1024;
    internal const int MaximumImportedLongSide = 2048;
    private const int ImportedJpegQuality = 92;
    private static readonly HashSet<string> SupportedExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png" };

    private readonly CameraAnnotationStore _store;
    private readonly ICameraDatasetChangeTracker? _changeTracker;

    public CameraImageImportService(CameraAnnotationStore store, ICameraDatasetChangeTracker? changeTracker = null)
    {
        _store = store;
        _changeTracker = changeTracker;
    }

    public CameraImportResult Import(IReadOnlyList<string> sourceFolders, string? captureCondition)
    {
        Directory.CreateDirectory(_store.ImportsRoot);
        var batchId = CreateBatchId(_store.ImportsRoot);
        var batchRoot = Path.Combine(_store.ImportsRoot, batchId);
        Directory.CreateDirectory(batchRoot);

        var imported = 0;
        var skipped = 0;
        var failed = 0;
        var errors = new List<string>();
        var sources = new List<CameraImportSource>();
        var usedRootNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var sourceFolder in sourceFolders.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Directory.Exists(sourceFolder))
            {
                failed++;
                errors.Add($"Folder not found: {sourceFolder}");
                continue;
            }

            var importedFolder = UniqueName(Sanitize(Path.GetFileName(sourceFolder.TrimEnd(Path.DirectorySeparatorChar))), usedRootNames);
            usedRootNames.Add(importedFolder);
            var sourceGroup = $"{batchId}/{importedFolder}";
            sources.Add(new CameraImportSource(sourceFolder, importedFolder, sourceGroup));

            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(sourceFolder, "*", SearchOption.AllDirectories).ToArray();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                failed++;
                errors.Add($"Could not scan {sourceFolder}: {error.Message}");
                continue;
            }

            foreach (var sourcePath in files.OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                if (!SupportedExtensions.Contains(Path.GetExtension(sourcePath)))
                {
                    skipped++;
                    continue;
                }

                string? destinationPath = null;
                try
                {
                    var relative = Path.GetRelativePath(sourceFolder, sourcePath);
                    var destinationDirectory = Path.Combine(batchRoot, importedFolder, Path.GetDirectoryName(relative) ?? string.Empty);
                    Directory.CreateDirectory(destinationDirectory);
                    destinationPath = ResolveImageCollision(destinationDirectory, Path.GetFileName(sourcePath));
                    var normalized = NormalizeImage(sourcePath, destinationPath);
                    try
                    {
                        ImportAnnotation(sourcePath, destinationPath, normalized, sourceGroup, captureCondition);
                    }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
                    {
                        failed++;
                        errors.Add($"Annotation for {sourcePath}: {error.Message}");
                    }
                    imported++;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or NotSupportedException)
                {
                    if (destinationPath is not null)
                    {
                        var sidecar = CameraAnnotationStore.AnnotationPathFor(destinationPath);
                        if (File.Exists(sidecar)) File.Delete(sidecar);
                        if (File.Exists(destinationPath)) File.Delete(destinationPath);
                    }
                    failed++;
                    errors.Add($"{sourcePath}: {error.Message}");
                }
            }
        }

        var descriptor = new CameraImportDescriptor(1, batchId, DateTimeOffset.UtcNow,
            string.IsNullOrWhiteSpace(captureCondition) ? null : captureCondition.Trim(), sources);
        CameraAnnotationStore.WriteAtomic(Path.Combine(batchRoot, ".deckino-import.json"), descriptor, overwrite: false);
        _changeTracker?.TrackTree(batchRoot);
        return new CameraImportResult(batchRoot, imported, skipped, failed, errors);
    }

    public static NormalizedPoint TransformPoint(NormalizedPoint point, ushort orientation) => orientation switch
    {
        2 => new(1 - point.X, point.Y),
        3 => new(1 - point.X, 1 - point.Y),
        4 => new(point.X, 1 - point.Y),
        5 => new(point.Y, point.X),
        6 => new(1 - point.Y, point.X),
        7 => new(1 - point.Y, 1 - point.X),
        8 => new(point.Y, 1 - point.X),
        _ => point,
    };

    internal static (int Width, int Height) CalculateImportedDimensions(int width, int height)
    {
        if (width <= 0 || height <= 0) throw new ArgumentOutOfRangeException(nameof(width));
        var shortSide = Math.Min(width, height);
        var longSide = Math.Max(width, height);
        var scale = Math.Min(1d, Math.Min(
            MaximumImportedShortSide / (double)shortSide,
            MaximumImportedLongSide / (double)longSide));
        return (
            Math.Max(1, (int)Math.Round(width * scale)),
            Math.Max(1, (int)Math.Round(height * scale)));
    }

    private void ImportAnnotation(
        string sourceImage,
        string destinationImage,
        NormalizedImage normalized,
        string sourceGroup,
        string? captureCondition)
    {
        var sourceAnnotationPath = CameraAnnotationStore.AnnotationPathFor(sourceImage);
        if (!File.Exists(sourceAnnotationPath)) return;
        var source = _store.TryLoad(sourceAnnotationPath);
        if (source is null) throw new JsonException("The matching annotation is not valid JSON.");
        if (!Path.GetFileName(sourceImage).Equals(source.ImageFile, StringComparison.OrdinalIgnoreCase)) return;

        NormalizedPoint? Transform(NormalizedPoint? point) =>
            point is null ? null : TransformPoint(point, normalized.SourceOrientation);
        var imported = new CardAnnotation
        {
            DatasetVersion = source.DatasetVersion,
            ImageFile = Path.GetFileName(destinationImage),
            CardPresent = source.CardPresent,
            TopLeft = Transform(source.TopLeft),
            TopRight = Transform(source.TopRight),
            BottomRight = Transform(source.BottomRight),
            BottomLeft = Transform(source.BottomLeft),
            ImageWidth = normalized.Width,
            ImageHeight = normalized.Height,
            SourceGroup = string.IsNullOrWhiteSpace(source.SourceGroup) ? sourceGroup : source.SourceGroup,
            CaptureCondition = string.IsNullOrWhiteSpace(source.CaptureCondition) ? captureCondition : source.CaptureCondition,
            Split = source.Split,
        };
        if (!CameraAnnotationStore.IsValid(imported)) throw new JsonException("The matching annotation has invalid fields.");
        _store.WriteImported(destinationImage, imported);
    }

    private static NormalizedImage NormalizeImage(string sourcePath, string destinationPath)
    {
        using var stream = File.Open(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var source = DrawingImage.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true);
        var orientation = ReadOrientation(source);
        var swapsDimensions = orientation is >= 5 and <= 8;
        var orientedWidth = swapsDimensions ? source.Height : source.Width;
        var orientedHeight = swapsDimensions ? source.Width : source.Height;
        var (targetWidth, targetHeight) = CalculateImportedDimensions(orientedWidth, orientedHeight);
        if (orientation == 1 && targetWidth == source.Width && targetHeight == source.Height)
        {
            CopyAtomic(sourcePath, destinationPath);
            return new(source.Width, source.Height, orientation);
        }

        using var oriented = new Bitmap(source);
        ApplyOrientation(oriented, orientation);
        // Draw into a fresh bitmap even when no resize is required. This strips the
        // source EXIF orientation metadata before the normalized image is encoded.
        using var output = Resize(oriented, targetWidth, targetHeight);
        WriteBitmapAtomic(destinationPath, output);
        return new(targetWidth, targetHeight, orientation);
    }

    private static Bitmap Resize(DrawingImage source, int width, int height)
    {
        var result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        result.SetResolution(source.HorizontalResolution > 0 ? source.HorizontalResolution : 96,
            source.VerticalResolution > 0 ? source.VerticalResolution : 96);
        using var graphics = Graphics.FromImage(result);
        graphics.CompositingMode = CompositingMode.SourceCopy;
        graphics.CompositingQuality = CompositingQuality.HighQuality;
        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
        graphics.SmoothingMode = SmoothingMode.HighQuality;
        graphics.DrawImage(source, new Rectangle(0, 0, width, height));
        return result;
    }

    private static void ApplyOrientation(DrawingImage image, ushort orientation)
    {
        var operation = orientation switch
        {
            2 => RotateFlipType.RotateNoneFlipX,
            3 => RotateFlipType.Rotate180FlipNone,
            4 => RotateFlipType.RotateNoneFlipY,
            5 => RotateFlipType.Rotate90FlipX,
            6 => RotateFlipType.Rotate90FlipNone,
            7 => RotateFlipType.Rotate270FlipX,
            8 => RotateFlipType.Rotate270FlipNone,
            _ => RotateFlipType.RotateNoneFlipNone,
        };
        image.RotateFlip(operation);
    }

    private static ushort ReadOrientation(DrawingImage image)
    {
        try
        {
            const int ExifOrientationId = 0x0112;
            if (image.PropertyIdList.Contains(ExifOrientationId)
                && image.GetPropertyItem(ExifOrientationId)?.Value is { Length: >= 2 } value)
                return BitConverter.ToUInt16(value, 0);
        }
        catch (ArgumentException) { }
        return 1;
    }

    private static string ResolveImageCollision(string directory, string fileName)
    {
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var extension = Path.GetExtension(fileName).ToLowerInvariant();
        for (var suffix = 1; ; suffix++)
        {
            var candidateStem = suffix == 1 ? stem : $"{stem}_{suffix}";
            var hasStemCollision = Directory.EnumerateFiles(directory)
                .Any(path => Path.GetFileNameWithoutExtension(path).Equals(candidateStem, StringComparison.OrdinalIgnoreCase));
            if (!hasStemCollision) return Path.Combine(directory, candidateStem + extension);
        }
    }

    private static string CreateBatchId(string importsRoot)
    {
        while (true)
        {
            var candidate = $"{DateTime.Now:yyyy-MM-dd_HH-mm-ss}-{Guid.NewGuid():N}"[..28];
            if (!Directory.Exists(Path.Combine(importsRoot, candidate))) return candidate;
        }
    }

    private static string Sanitize(string value)
    {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var clean = new string(value.Select(character => invalid.Contains(character) ? '_' : character).ToArray()).Trim();
        return string.IsNullOrWhiteSpace(clean) ? "camera-photos" : clean;
    }

    private static string UniqueName(string baseName, IReadOnlySet<string> used)
    {
        for (var suffix = 1; ; suffix++)
        {
            var candidate = suffix == 1 ? baseName : $"{baseName}_{suffix}";
            if (!used.Contains(candidate)) return candidate;
        }
    }

    private static void CopyAtomic(string source, string destination)
    {
        var temporary = destination + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.Copy(source, temporary, overwrite: false);
            File.Move(temporary, destination, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void WriteBitmapAtomic(string destination, Bitmap bitmap)
    {
        var temporary = destination + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            if (Path.GetExtension(destination).Equals(".png", StringComparison.OrdinalIgnoreCase))
            {
                bitmap.Save(temporary, DrawingImageFormat.Png);
            }
            else
            {
                var encoder = ImageCodecInfo.GetImageEncoders().Single(codec => codec.FormatID == DrawingImageFormat.Jpeg.Guid);
                using var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(Encoder.Quality, (long)ImportedJpegQuality);
                bitmap.Save(temporary, encoder, parameters);
            }
            File.Move(temporary, destination, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private sealed record NormalizedImage(int Width, int Height, ushort SourceOrientation);
}
