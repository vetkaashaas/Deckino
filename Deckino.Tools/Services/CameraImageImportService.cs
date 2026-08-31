using System.IO;
using System.Text.Json;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Deckino.Tools.Services;

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
        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        var frame = decoder.Frames[0];
        var orientation = ReadOrientation(frame.Metadata);
        var swapsDimensions = orientation is >= 5 and <= 8;
        var orientedWidth = swapsDimensions ? frame.PixelHeight : frame.PixelWidth;
        var orientedHeight = swapsDimensions ? frame.PixelWidth : frame.PixelHeight;
        var (targetWidth, targetHeight) = CalculateImportedDimensions(orientedWidth, orientedHeight);
        if (orientation == 1 && targetWidth == frame.PixelWidth && targetHeight == frame.PixelHeight)
        {
            CopyAtomic(sourcePath, destinationPath);
            return new(frame.PixelWidth, frame.PixelHeight, orientation);
        }

        BitmapSource bitmap = orientation == 1 ? frame : ApplyOrientation(frame, orientation);
        if (bitmap.PixelWidth != targetWidth || bitmap.PixelHeight != targetHeight)
        {
            bitmap = new TransformedBitmap(
                bitmap,
                new ScaleTransform(
                    targetWidth / (double)bitmap.PixelWidth,
                    targetHeight / (double)bitmap.PixelHeight));
        }
        BitmapEncoder encoder = Path.GetExtension(destinationPath).Equals(".png", StringComparison.OrdinalIgnoreCase)
            ? new PngBitmapEncoder()
            : new JpegBitmapEncoder { QualityLevel = ImportedJpegQuality };
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        WriteBitmapAtomic(destinationPath, encoder);
        return new(targetWidth, targetHeight, orientation);
    }

    private static BitmapSource ApplyOrientation(BitmapSource frame, ushort orientation)
    {
        var source = new FormatConvertedBitmap(frame, PixelFormats.Bgra32, null, 0);
        var sourceStride = source.PixelWidth * 4;
        var sourcePixels = new byte[sourceStride * source.PixelHeight];
        source.CopyPixels(sourcePixels, sourceStride, 0);
        var swapsDimensions = orientation is >= 5 and <= 8;
        var width = swapsDimensions ? source.PixelHeight : source.PixelWidth;
        var height = swapsDimensions ? source.PixelWidth : source.PixelHeight;
        var destinationStride = width * 4;
        var destinationPixels = new byte[destinationStride * height];

        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var (sourceX, sourceY) = MapDestinationToSource(
                    x, y, source.PixelWidth, source.PixelHeight, orientation);
                Buffer.BlockCopy(sourcePixels, sourceY * sourceStride + sourceX * 4,
                    destinationPixels, y * destinationStride + x * 4, 4);
            }

        return BitmapSource.Create(
            width,
            height,
            frame.DpiX > 0 ? frame.DpiX : 96,
            frame.DpiY > 0 ? frame.DpiY : 96,
            PixelFormats.Bgra32,
            null,
            destinationPixels,
            destinationStride);
    }

    private static ushort ReadOrientation(ImageMetadata? metadata)
    {
        try
        {
            if (metadata is BitmapMetadata bitmapMetadata)
            {
                foreach (var query in new[] { "/app1/ifd/{ushort=274}", "/ifd/{ushort=274}" })
                {
                    var value = bitmapMetadata.GetQuery(query);
                    if (value is not null) return Convert.ToUInt16(value);
                }
            }
        }
        catch (NotSupportedException) { }
        return 1;
    }

    private static (int X, int Y) MapDestinationToSource(int x, int y, int width, int height, ushort orientation) => orientation switch
    {
        2 => (width - 1 - x, y),
        3 => (width - 1 - x, height - 1 - y),
        4 => (x, height - 1 - y),
        5 => (y, x),
        6 => (y, height - 1 - x),
        7 => (width - 1 - y, height - 1 - x),
        8 => (width - 1 - y, x),
        _ => (x, y),
    };

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

    private static void WriteBitmapAtomic(string destination, BitmapEncoder encoder)
    {
        var temporary = destination + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var output = File.Create(temporary)) encoder.Save(output);
            File.Move(temporary, destination, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private sealed record NormalizedImage(int Width, int Height, ushort SourceOrientation);
}
