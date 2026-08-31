using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows.Media.Imaging;

namespace Deckino.Tools.Services;

public sealed class CameraAnnotationStore
{
    public static readonly IReadOnlyList<string> CornerOrder =
        ["TopLeft", "TopRight", "BottomRight", "BottomLeft"];

    private static readonly HashSet<string> ImageExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png" };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private readonly TrainingPaths _paths;
    private readonly ICameraDatasetChangeTracker? _changeTracker;

    public CameraAnnotationStore(TrainingPaths paths, ICameraDatasetChangeTracker? changeTracker = null)
    {
        _paths = paths;
        _changeTracker = changeTracker;
    }

    public string ImportsRoot => _paths.CameraImportsRoot;

    public static string AnnotationPathFor(string imagePath) =>
        Path.Combine(
            Path.GetDirectoryName(imagePath)!,
            Path.GetFileNameWithoutExtension(imagePath) + "._annotations.json");

    public IReadOnlyList<CameraPhoto> ScanPhotos()
    {
        if (!Directory.Exists(ImportsRoot)) return [];

        var descriptors = LoadDescriptors();
        var photos = new List<CameraPhoto>();
        foreach (var imagePath in Directory.EnumerateFiles(ImportsRoot, "*", SearchOption.AllDirectories)
                     .Where(path => ImageExtensions.Contains(Path.GetExtension(path)))
                     .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var annotationPath = AnnotationPathFor(imagePath);
                var annotationExists = File.Exists(annotationPath);
                var annotation = annotationExists ? TryLoad(annotationPath) : null;
                var valid = annotation is not null && IsValid(annotation);
                var (width, height) = ReadDimensions(imagePath);
                var descriptor = FindDescriptor(imagePath, descriptors);
                photos.Add(new CameraPhoto(
                    imagePath,
                    Path.GetRelativePath(ImportsRoot, imagePath),
                    annotationPath,
                    !string.IsNullOrWhiteSpace(annotation?.SourceGroup)
                        ? annotation.SourceGroup
                        : ResolveSourceGroup(imagePath, descriptor),
                    annotation?.CaptureCondition ?? descriptor?.CaptureCondition,
                    width,
                    height,
                    valid,
                    annotationExists && !valid));
            }
            catch (Exception) when (File.Exists(imagePath))
            {
                // A corrupt or concurrently removed image must not hide the rest of the library.
            }
        }
        return photos;
    }

    public CardAnnotation? TryLoad(string annotationPath)
    {
        try
        {
            return JsonSerializer.Deserialize<CardAnnotation>(File.ReadAllText(annotationPath), JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    public void SaveNew(string imagePath, CardAnnotation annotation)
    {
        var path = AnnotationPathFor(imagePath);
        if (File.Exists(path))
        {
            throw new IOException($"An annotation already exists for {Path.GetFileName(imagePath)}.");
        }
        WriteAtomic(path, annotation, overwrite: false);
        _changeTracker?.TrackUpload(path);
    }

    public void WriteImported(string imagePath, CardAnnotation annotation)
    {
        var path = AnnotationPathFor(imagePath);
        WriteAtomic(path, annotation, overwrite: true);
        _changeTracker?.TrackUpload(path);
    }

    public CameraDeleteResult DeleteFiles(IReadOnlyList<CameraPhoto> photos, bool deletePhotos)
    {
        var deletedPhotos = 0;
        var deletedAnnotations = 0;
        var errors = new List<string>();
        foreach (var photo in photos)
        {
            try
            {
                if (File.Exists(photo.AnnotationPath))
                {
                    File.Delete(photo.AnnotationPath);
                    _changeTracker?.TrackDeletion(photo.AnnotationPath);
                    deletedAnnotations++;
                }
                if (deletePhotos && File.Exists(photo.ImagePath))
                {
                    File.Delete(photo.ImagePath);
                    _changeTracker?.TrackDeletion(photo.ImagePath);
                    deletedPhotos++;
                }
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                errors.Add($"{photo.RelativePath}: {error.Message}");
            }
        }
        return new(deletedPhotos, deletedAnnotations, errors);
    }

    public static bool IsValid(CardAnnotation annotation)
    {
        if (annotation.ImageWidth <= 0 || annotation.ImageHeight <= 0 || string.IsNullOrWhiteSpace(annotation.ImageFile))
        {
            return false;
        }
        if (!annotation.CardPresent) return annotation.Points.All(point => point is null);
        return annotation.Points.All(point => point is not null &&
            point.X is >= 0 and <= 1 && point.Y is >= 0 and <= 1);
    }

    public static (int Width, int Height) ReadDimensions(string imagePath)
    {
        using var stream = File.Open(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.None);
        return (decoder.Frames[0].PixelWidth, decoder.Frames[0].PixelHeight);
    }

    public static void WriteAtomic<T>(string path, T value, bool overwrite)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporaryPath = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(value, JsonOptions), new UTF8Encoding(false));
            File.Move(temporaryPath, path, overwrite);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private IReadOnlyList<(string Root, CameraImportDescriptor Descriptor)> LoadDescriptors()
    {
        var descriptors = new List<(string, CameraImportDescriptor)>();
        foreach (var path in Directory.EnumerateFiles(ImportsRoot, ".deckino-import.json", SearchOption.AllDirectories))
        {
            try
            {
                var descriptor = JsonSerializer.Deserialize<CameraImportDescriptor>(File.ReadAllText(path), JsonOptions);
                if (descriptor is not null) descriptors.Add((Path.GetDirectoryName(path)!, descriptor));
            }
            catch (JsonException) { }
            catch (IOException) { }
        }
        return descriptors.OrderByDescending(item => item.Item1.Length).ToArray();
    }

    private static CameraImportDescriptor? FindDescriptor(
        string imagePath,
        IReadOnlyList<(string Root, CameraImportDescriptor Descriptor)> descriptors) =>
        descriptors.FirstOrDefault(item => Path.GetFullPath(imagePath).StartsWith(
            Path.GetFullPath(item.Root) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase)).Descriptor;

    private static string ResolveSourceGroup(string imagePath, CameraImportDescriptor? descriptor)
    {
        if (descriptor is null) return string.Empty;
        foreach (var source in descriptor.Sources)
        {
            var sourceRoot = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(imagePath)) ?? string.Empty, source.ImportedFolder);
            if (Path.GetFullPath(imagePath).Contains(
                    Path.DirectorySeparatorChar + source.ImportedFolder + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
            {
                return source.SourceGroup;
            }
        }
        return descriptor.BatchId;
    }
}
