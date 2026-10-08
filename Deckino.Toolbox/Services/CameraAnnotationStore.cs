using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Drawing;
using DrawingImage = System.Drawing.Image;

namespace Deckino.Toolbox.Services;

public sealed class CameraAnnotationStore
{
    public static readonly IReadOnlyList<string> CornerOrder =
        ["TopLeft", "TopRight", "BottomRight", "BottomLeft"];
    // Each point is the intersection of the two straight card edges (rounded corners ignored).
    public const string CornerConvention = "edge-intersection-v1";

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

    // Outside ImportsRoot so dataset sync never sees the cache.
    public string ThumbnailsRoot => Path.Combine(_paths.CameraRoot, "thumbnails");

    // A small JPEG of the photo, cached on disk. The key includes size and write time, so a replaced photo
    // gets a fresh thumbnail.
    // ponytail: thumbnails of deleted photos stay in the cache; prune ThumbnailsRoot if it ever grows large.
    public byte[] LoadThumbnail(string imagePath, int maxSize = 320)
    {
        var cachePath = ThumbnailCachePath(imagePath, maxSize);
        if (File.Exists(cachePath)) return File.ReadAllBytes(cachePath);

        byte[] bytes;
        using (var stream = File.OpenRead(imagePath))
        using (var source = DrawingImage.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: false))
        {
            var scale = Math.Min(1.0, maxSize / (double)Math.Max(source.Width, source.Height));
            var width = Math.Max(1, (int)Math.Round(source.Width * scale));
            var height = Math.Max(1, (int)Math.Round(source.Height * scale));
            using var thumbnail = new Bitmap(width, height);
            using (var graphics = Graphics.FromImage(thumbnail))
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                graphics.DrawImage(source, 0, 0, width, height);
            }
            using var output = new MemoryStream();
            thumbnail.Save(output, System.Drawing.Imaging.ImageFormat.Jpeg);
            bytes = output.ToArray();
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(cachePath)!);
            var temp = cachePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, cachePath, overwrite: true);
        }
        catch (IOException)
        {
            // The cache is best effort; the thumbnail is still shown.
        }
        return bytes;
    }

    // Makes sure the thumbnail is in the disk cache without reading it back when it already is.
    public void WarmThumbnail(string imagePath, int maxSize = 320)
    {
        if (!File.Exists(ThumbnailCachePath(imagePath, maxSize))) LoadThumbnail(imagePath, maxSize);
    }

    private string ThumbnailCachePath(string imagePath, int maxSize)
    {
        var info = new FileInfo(imagePath);
        var key = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(
            Encoding.UTF8.GetBytes($"{info.FullName.ToUpperInvariant()}|{info.Length}|{info.LastWriteTimeUtc.Ticks}|{maxSize}")));
        return Path.Combine(ThumbnailsRoot, key[..2], key + ".jpg");
    }

    public static string AnnotationPathFor(string imagePath) =>
        Path.Combine(
            Path.GetDirectoryName(imagePath)!,
            Path.GetFileNameWithoutExtension(imagePath) + "._annotations.json");

    public static string IdentityPathFor(string imagePath) =>
        Path.Combine(
            Path.GetDirectoryName(imagePath)!,
            Path.GetFileNameWithoutExtension(imagePath) + "._identity.json");

    public IReadOnlyList<CameraPhoto> ScanPhotos() => ScanPhotos(out _);

    // skipped: image files that could not be read (corrupt, locked, or removed mid-scan).
    public IReadOnlyList<CameraPhoto> ScanPhotos(out int skipped)
    {
        skipped = 0;
        if (!Directory.Exists(ImportsRoot)) return [];

        // One directory walk; its FileInfos already carry size and write time, so no per-file stat calls follow.
        var all = new DirectoryInfo(ImportsRoot).EnumerateFiles("*", SearchOption.AllDirectories).ToArray();
        // Only for finding each photo's annotation; TryAdd because a case-sensitive folder can hold names that differ by case.
        var files = new Dictionary<string, FileInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in all) files.TryAdd(file.FullName, file);
        var descriptors = LoadDescriptors(all);
        var scanned = all
            .Where(file => ImageExtensions.Contains(file.Extension))
            .OrderBy(file => file.FullName, StringComparer.OrdinalIgnoreCase)
            .AsParallel().AsOrdered()
            .Select(file => ScanPhoto(file, files, descriptors))
            .ToArray();
        var photos = scanned.OfType<CameraPhoto>().ToArray();
        skipped = scanned.Length - photos.Length;
        return photos;
    }

    // Dimensions and annotation summaries, keyed by path + size + write time so a rescan only reads changed files.
    // ponytail: entries for replaced or deleted files are never evicted; fine for tens of thousands of photos.
    private readonly ConcurrentDictionary<string, (int Width, int Height)> _dimensions = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, (bool Valid, string? SourceGroup, string? CaptureCondition)> _annotations =
        new(StringComparer.OrdinalIgnoreCase);

    private static string StampOf(FileInfo file) => $"{file.FullName}|{file.Length}|{file.LastWriteTimeUtc.Ticks}";

    private CameraPhoto? ScanPhoto(
        FileInfo image,
        Dictionary<string, FileInfo> files,
        IReadOnlyList<(string Root, CameraImportDescriptor Descriptor)> descriptors)
    {
        var imagePath = image.FullName;
        try
        {
            var annotationPath = AnnotationPathFor(imagePath);
            var annotationExists = files.TryGetValue(annotationPath, out var annotationFile);
            var annotation = annotationExists ? SummarizeAnnotation(annotationFile!) : default;
            var (width, height) = _dimensions.GetOrAdd(StampOf(image), _ => ReadDimensions(imagePath));
            var descriptor = FindDescriptor(imagePath, descriptors);
            return new CameraPhoto(
                imagePath,
                Path.GetRelativePath(ImportsRoot, imagePath),
                annotationPath,
                !string.IsNullOrWhiteSpace(annotation.SourceGroup)
                    ? annotation.SourceGroup
                    : ResolveSourceGroup(imagePath, descriptor),
                annotation.CaptureCondition ?? descriptor?.CaptureCondition,
                width,
                height,
                annotation.Valid,
                annotationExists && !annotation.Valid,
                image.LastWriteTimeUtc,
                image.Length);
        }
        catch (Exception)
        {
            // A corrupt or concurrently removed image must not hide the rest of the library.
            return null;
        }
    }

    private (bool Valid, string? SourceGroup, string? CaptureCondition) SummarizeAnnotation(FileInfo file)
    {
        var stamp = StampOf(file);
        if (_annotations.TryGetValue(stamp, out var cached)) return cached;
        CardAnnotation? loaded;
        try
        {
            loaded = Deserialize(file.FullName);
        }
        catch (IOException)
        {
            // Locked or just removed: report it as unreadable this time, but read it again on the next scan.
            return (false, null, null);
        }
        return _annotations[stamp] = (loaded is not null && IsValid(loaded), loaded?.SourceGroup, loaded?.CaptureCondition);
    }

    public CardAnnotation? TryLoad(string annotationPath)
    {
        try
        {
            return Deserialize(annotationPath);
        }
        catch (IOException)
        {
            return null;
        }
    }

    // Null for unreadable JSON; IOException is left to the caller, since a locked file may read fine later.
    private static CardAnnotation? Deserialize(string annotationPath)
    {
        try
        {
            return JsonSerializer.Deserialize<CardAnnotation>(File.ReadAllText(annotationPath), JsonOptions);
        }
        catch (JsonException)
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

    public void UpdateExisting(string imagePath, CardAnnotation annotation)
    {
        var path = AnnotationPathFor(imagePath);
        if (!File.Exists(path))
        {
            throw new IOException($"The annotation for {Path.GetFileName(imagePath)} no longer exists.");
        }
        WriteAtomic(path, annotation, overwrite: true);
        _changeTracker?.TrackUpload(path);
    }

    public CardIdentity? TryLoadIdentity(string imagePath)
    {
        var path = IdentityPathFor(imagePath);
        if (!File.Exists(path)) return null;
        try
        {
            var identity = JsonSerializer.Deserialize<CardIdentity>(File.ReadAllText(path), JsonOptions);
            return identity is not null && IsValid(identity) ? identity : null;
        }
        catch (Exception error) when (error is JsonException or IOException)
        {
            return null;
        }
    }

    public void SaveIdentity(string imagePath, CardIdentity identity)
    {
        if (!IsValid(identity)) throw new InvalidDataException("The card identity has invalid fields.");
        var path = IdentityPathFor(imagePath);
        WriteAtomic(path, identity, overwrite: true);
        _changeTracker?.TrackUpload(path);
    }

    public static bool IsValid(CardIdentity identity) =>
        !string.IsNullOrWhiteSpace(identity.ImageFile)
        && CardIdentityStatus.All.Contains(identity.Status)
        && (identity.Status is not (CardIdentityStatus.Confirmed or CardIdentityStatus.Corrected)
            || Guid.TryParse(identity.OracleId, out _))
        && (identity.PredictedCorners is null || (identity.PredictedCorners.Count == 4
            && identity.PredictedCorners.All(point => point.X is >= 0 and <= 1 && point.Y is >= 0 and <= 1)));

    public void WriteImported(string imagePath, CardAnnotation annotation)
    {
        var path = AnnotationPathFor(imagePath);
        WriteAtomic(path, annotation, overwrite: true);
        _changeTracker?.TrackUpload(path);
    }

    // Photos in a frozen artwork benchmark. Deleting one would leave every later model unscorable on that benchmark.
    public IReadOnlySet<string> BenchmarkPhotoPaths()
    {
        var protectedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!Directory.Exists(_paths.BenchmarksRoot)) return protectedPaths;
        foreach (var file in Directory.EnumerateFiles(_paths.BenchmarksRoot, "artwork-*.json"))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(file));
            foreach (var photo in document.RootElement.GetProperty("photos").EnumerateArray())
                protectedPaths.Add(Path.GetFullPath(Path.Combine(ImportsRoot, photo.GetProperty("photo").GetString()!)));
        }
        return protectedPaths;
    }

    public CameraDeleteResult DeleteFiles(IReadOnlyList<CameraPhoto> photos, bool deletePhotos)
    {
        var deletedPhotos = 0;
        var deletedAnnotations = 0;
        var errors = new List<string>();
        var benchmarked = deletePhotos ? BenchmarkPhotoPaths() : new HashSet<string>();
        foreach (var photo in photos)
        {
            if (benchmarked.Contains(Path.GetFullPath(photo.ImagePath)))
            {
                errors.Add($"{photo.RelativePath}: kept, it is in a frozen model benchmark.");
                continue;
            }
            try
            {
                if (File.Exists(photo.AnnotationPath))
                {
                    File.Delete(photo.AnnotationPath);
                    _changeTracker?.TrackDeletion(photo.AnnotationPath);
                    deletedAnnotations++;
                }
                if (deletePhotos && File.Exists(photo.IdentityPath))
                {
                    File.Delete(photo.IdentityPath);
                    _changeTracker?.TrackDeletion(photo.IdentityPath);
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
        // Without validation GDI+ reads only the header instead of decoding the whole photo.
        using var image = DrawingImage.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: false);
        return (image.Width, image.Height);
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

    private static IReadOnlyList<(string Root, CameraImportDescriptor Descriptor)> LoadDescriptors(IEnumerable<FileInfo> files)
    {
        var descriptors = new List<(string, CameraImportDescriptor)>();
        foreach (var path in files.Where(file => file.Name.Equals(".deckino-import.json", StringComparison.OrdinalIgnoreCase))
                     .Select(file => file.FullName))
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

public static class CameraPhotoQueue
{
    // ponytail: "newest" is the local file time, so on a fresh clone it is the sync download order.
    public static IOrderedEnumerable<CameraPhoto> OrderByQueue(this IEnumerable<CameraPhoto> photos, bool newestFirst) =>
        photos.OrderByQueue(photo => photo, newestFirst);

    public static IOrderedEnumerable<T> OrderByQueue<T>(this IEnumerable<T> items, Func<T, CameraPhoto> photo, bool newestFirst) =>
        (newestFirst
            ? items.OrderByDescending(item => photo(item).ModifiedUtc)
            : items.OrderBy(item => photo(item).ModifiedUtc))
        .ThenBy(item => photo(item).RelativePath, StringComparer.OrdinalIgnoreCase);
}
