using System.Text.Json;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class CameraAnnotationTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "deckino-camera-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void UsesExactSidecarNameAndWritesPascalCaseAtomically()
    {
        var paths = new TrainingPaths(_root);
        var store = new CameraAnnotationStore(paths);
        var imagePath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.jpg");
        WriteImage(imagePath, 64, 88, png: false);
        var annotation = CreateAnnotation("photo.jpg", 64, 88);

        store.SaveNew(imagePath, annotation);

        var sidecar = Path.Combine(Path.GetDirectoryName(imagePath)!, "photo._annotations.json");
        Assert.True(File.Exists(sidecar));
        Assert.False(File.Exists(sidecar + ".tmp"));
        using var json = JsonDocument.Parse(File.ReadAllText(sidecar));
        Assert.Equal(1, json.RootElement.GetProperty("SchemaVersion").GetInt32());
        Assert.Equal("corners-v1", json.RootElement.GetProperty("DatasetVersion").GetString());
        Assert.Equal("TopLeft", json.RootElement.GetProperty("CornerOrder")[0].GetString());
        Assert.Throws<IOException>(() => store.SaveNew(imagePath, annotation));
    }

    [Fact]
    public void ValidatesPositiveAndNoCardContracts()
    {
        var positive = CreateAnnotation("card.png", 100, 200);
        var noCard = new CardAnnotation
        {
            ImageFile = "empty.png",
            CardPresent = false,
            ImageWidth = 100,
            ImageHeight = 100,
            SourceGroup = "batch/source",
        };

        Assert.True(CameraAnnotationStore.IsValid(positive));
        Assert.True(CameraAnnotationStore.IsValid(noCard));
        Assert.False(CameraAnnotationStore.IsValid(WithTopLeft(positive, new(-0.1, 0.1))));
    }

    [Fact]
    public void ImportsFoldersPreservesLayoutAndUpgradesLegacyLabels()
    {
        var source = Path.Combine(_root, "source", "session-one");
        var nested = Path.Combine(source, "nested");
        var imagePath = Path.Combine(nested, "capture.png");
        WriteImage(imagePath, 80, 120, png: true);
        File.WriteAllText(CameraAnnotationStore.AnnotationPathFor(imagePath),
            """
            {
              "ImageFile": "capture.png",
              "TopLeft": { "X": 0.1, "Y": 0.1 },
              "TopRight": { "X": 0.9, "Y": 0.1 },
              "BottomRight": { "X": 0.9, "Y": 0.9 },
              "BottomLeft": { "X": 0.1, "Y": 0.9 },
              "ImageWidth": 80,
              "ImageHeight": 120
            }
            """);
        File.WriteAllText(Path.Combine(source, "notes.txt"), "not an image");
        var store = new CameraAnnotationStore(new TrainingPaths(Path.Combine(_root, "working")));

        var result = new CameraImageImportService(store).Import([source], "indoor-glare");

        Assert.Equal(1, result.Imported);
        Assert.Equal(2, result.Skipped); // notes plus source annotation JSON
        Assert.Equal(0, result.Failed);
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$", Path.GetFileName(result.BatchRoot));
        var imported = Assert.Single(store.ScanPhotos());
        Assert.Contains(Path.Combine("session-one", "nested", "capture.png"), imported.RelativePath);
        Assert.True(imported.IsAnnotated);
        var annotation = store.TryLoad(imported.AnnotationPath)!;
        Assert.Equal(1, annotation.SchemaVersion);
        Assert.True(annotation.CardPresent);
        Assert.Equal("indoor-glare", annotation.CaptureCondition);
        Assert.EndsWith("/session-one", annotation.SourceGroup, StringComparison.Ordinal);
        Assert.True(File.Exists(Path.Combine(result.BatchRoot, ".deckino-import.json")));
    }

    [Fact]
    public void ImportNormalizesExifRotationAndTransformsImportedCorners()
    {
        var source = Path.Combine(_root, "rotated-source");
        var imagePath = Path.Combine(source, "portrait.jpg");
        WriteImage(imagePath, 40, 80, png: false, orientation: 6);
        File.WriteAllText(CameraAnnotationStore.AnnotationPathFor(imagePath),
            """
            {
              "ImageFile": "portrait.jpg",
              "TopLeft": { "X": 0.2, "Y": 0.3 },
              "TopRight": { "X": 0.8, "Y": 0.3 },
              "BottomRight": { "X": 0.8, "Y": 0.7 },
              "BottomLeft": { "X": 0.2, "Y": 0.7 },
              "ImageWidth": 40,
              "ImageHeight": 80
            }
            """);
        var store = new CameraAnnotationStore(new TrainingPaths(Path.Combine(_root, "rotated-working")));

        var result = new CameraImageImportService(store).Import([source], null);

        Assert.Equal(1, result.Imported);
        var photo = Assert.Single(store.ScanPhotos());
        Assert.Equal(80, photo.ImageWidth);
        Assert.Equal(40, photo.ImageHeight);
        var annotation = store.TryLoad(photo.AnnotationPath)!;
        Assert.Equal(0.7, annotation.TopLeft!.X, 10);
        Assert.Equal(0.2, annotation.TopLeft.Y, 10);
    }

    [Theory]
    [InlineData(640, 853, 640, 853)]
    [InlineData(4032, 3024, 1365, 1024)]
    [InlineData(3000, 6000, 1024, 2048)]
    [InlineData(4000, 800, 2048, 410)]
    public void CalculatesBoundedImportDimensionsWithoutUpscaling(
        int width, int height, int expectedWidth, int expectedHeight)
    {
        var actual = CameraImageImportService.CalculateImportedDimensions(width, height);

        Assert.Equal(expectedWidth, actual.Width);
        Assert.Equal(expectedHeight, actual.Height);
    }

    [Fact]
    public void ImportDownscalesLargeExifNormalizedPhotoAndUpdatesAnnotationDimensions()
    {
        var source = Path.Combine(_root, "large-rotated-source");
        var imagePath = Path.Combine(source, "large.jpg");
        WriteImage(imagePath, 1200, 1600, png: false, orientation: 6);
        File.WriteAllText(CameraAnnotationStore.AnnotationPathFor(imagePath),
            """
            {
              "ImageFile": "large.jpg",
              "TopLeft": { "X": 0.2, "Y": 0.3 },
              "TopRight": { "X": 0.8, "Y": 0.3 },
              "BottomRight": { "X": 0.8, "Y": 0.7 },
              "BottomLeft": { "X": 0.2, "Y": 0.7 },
              "ImageWidth": 1200,
              "ImageHeight": 1600
            }
            """);
        var store = new CameraAnnotationStore(new TrainingPaths(Path.Combine(_root, "large-working")));

        var result = new CameraImageImportService(store).Import([source], null);

        Assert.Equal(1, result.Imported);
        Assert.Equal(0, result.Failed);
        var photo = Assert.Single(store.ScanPhotos());
        Assert.Equal(1365, photo.ImageWidth);
        Assert.Equal(1024, photo.ImageHeight);
        var annotation = store.TryLoad(photo.AnnotationPath)!;
        Assert.Equal(photo.ImageWidth, annotation.ImageWidth);
        Assert.Equal(photo.ImageHeight, annotation.ImageHeight);
        Assert.Equal(0.7, annotation.TopLeft!.X, 10);
        Assert.Equal(0.2, annotation.TopLeft.Y, 10);
    }

    [Fact]
    public void InvalidSourceAnnotationDoesNotDiscardTheImportedPhoto()
    {
        var source = Path.Combine(_root, "invalid-label-source");
        var imagePath = Path.Combine(source, "capture.png");
        WriteImage(imagePath, 40, 60, png: true);
        File.WriteAllText(CameraAnnotationStore.AnnotationPathFor(imagePath), "{ invalid json");
        var store = new CameraAnnotationStore(new TrainingPaths(Path.Combine(_root, "invalid-label-working")));

        var result = new CameraImageImportService(store).Import([source], null);

        Assert.Equal(1, result.Imported);
        Assert.Equal(1, result.Failed);
        var imported = Assert.Single(store.ScanPhotos());
        Assert.False(imported.IsAnnotated);
        Assert.False(File.Exists(imported.AnnotationPath));
    }

    [Fact]
    public void DeletesAnnotationsSeparatelyOrTogetherWithOwnedPhotos()
    {
        var paths = new TrainingPaths(_root);
        var store = new CameraAnnotationStore(paths);
        var batch = Path.Combine(paths.CameraImportsRoot, "batch", "source");
        var first = Path.Combine(batch, "first.png");
        var second = Path.Combine(batch, "second.png");
        WriteImage(first, 20, 30, png: true);
        WriteImage(second, 20, 30, png: true);
        store.SaveNew(first, CreateAnnotation("first.png", 20, 30));
        store.SaveNew(second, CreateAnnotation("second.png", 20, 30));
        var photos = store.ScanPhotos();

        var annotationOnly = store.DeleteFiles([photos.Single(photo => photo.ImagePath == first)], deletePhotos: false);
        var withPhoto = store.DeleteFiles([photos.Single(photo => photo.ImagePath == second)], deletePhotos: true);

        Assert.Equal(1, annotationOnly.DeletedAnnotations);
        Assert.Equal(0, annotationOnly.DeletedPhotos);
        Assert.True(File.Exists(first));
        Assert.False(File.Exists(CameraAnnotationStore.AnnotationPathFor(first)));
        Assert.Equal(1, withPhoto.DeletedAnnotations);
        Assert.Equal(1, withPhoto.DeletedPhotos);
        Assert.False(File.Exists(second));
        Assert.True(Directory.Exists(batch));
    }

    [Theory]
    [InlineData(1, 0.2, 0.3)]
    [InlineData(2, 0.8, 0.3)]
    [InlineData(3, 0.8, 0.7)]
    [InlineData(4, 0.2, 0.7)]
    [InlineData(5, 0.3, 0.2)]
    [InlineData(6, 0.7, 0.2)]
    [InlineData(7, 0.7, 0.8)]
    [InlineData(8, 0.3, 0.8)]
    public void TransformsPointsForEveryExifOrientation(int orientation, double expectedX, double expectedY)
    {
        var actual = CameraImageImportService.TransformPoint(new(0.2, 0.3), (ushort)orientation);
        Assert.Equal(expectedX, actual.X, 10);
        Assert.Equal(expectedY, actual.Y, 10);
    }

    [Fact]
    public void ValidatesGeometryAndBuildsMagicRatioPreview()
    {
        NormalizedPoint[] valid = [new(0.2, 0.1), new(0.8, 0.15), new(0.85, 0.9), new(0.15, 0.85)];
        NormalizedPoint[] crossed = [new(0.2, 0.1), new(0.85, 0.9), new(0.8, 0.15), new(0.15, 0.85)];
        var source = BitmapSource.Create(100, 140, 96, 96, PixelFormats.Bgra32, null, new byte[100 * 140 * 4], 400);

        Assert.True(CardGeometryService.Validate(valid).IsValid);
        Assert.False(CardGeometryService.Validate(crossed).IsValid);
        var preview = CardGeometryService.CreatePerspectivePreview(source, valid);
        Assert.Equal(CardGeometryService.PreviewWidth, preview.PixelWidth);
        Assert.Equal(CardGeometryService.PreviewHeight, preview.PixelHeight);
    }

    private static CardAnnotation CreateAnnotation(string imageFile, int width, int height) => new()
    {
        ImageFile = imageFile,
        TopLeft = new(0.1, 0.1),
        TopRight = new(0.9, 0.1),
        BottomRight = new(0.9, 0.9),
        BottomLeft = new(0.1, 0.9),
        ImageWidth = width,
        ImageHeight = height,
        SourceGroup = "batch/source",
    };

    private static CardAnnotation WithTopLeft(CardAnnotation source, NormalizedPoint topLeft) => new()
    {
        ImageFile = source.ImageFile,
        TopLeft = topLeft,
        TopRight = source.TopRight,
        BottomRight = source.BottomRight,
        BottomLeft = source.BottomLeft,
        ImageWidth = source.ImageWidth,
        ImageHeight = source.ImageHeight,
        SourceGroup = source.SourceGroup,
    };

    private static void WriteImage(string path, int width, int height, bool png, ushort orientation = 1)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var pixels = Enumerable.Repeat((byte)180, width * height * 4).ToArray();
        var bitmap = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, pixels, width * 4);
        BitmapEncoder encoder = png ? new PngBitmapEncoder() : new JpegBitmapEncoder { QualityLevel = 95 };
        BitmapMetadata? metadata = null;
        if (!png && orientation != 1)
        {
            metadata = new BitmapMetadata("jpg");
            metadata.SetQuery("/app1/ifd/{ushort=274}", orientation);
        }
        encoder.Frames.Add(BitmapFrame.Create(bitmap, null, metadata, null));
        using var output = File.Create(path);
        encoder.Save(output);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
