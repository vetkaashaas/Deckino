using System.Text.Json;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.CompilerServices;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Tests;

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
    public void UpdatesAnExistingAnnotationWithoutAllowingAnAccidentalCreate()
    {
        var paths = new TrainingPaths(Path.Combine(_root, "update-working"));
        var store = new CameraAnnotationStore(paths);
        var imagePath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.png");
        WriteImage(imagePath, 100, 140, png: true);
        var original = CreateAnnotation("photo.png", 100, 140);
        store.SaveNew(imagePath, original);
        var updated = WithTopLeft(original, new(.2, .25));

        store.UpdateExisting(imagePath, updated);

        Assert.Equal(updated.TopLeft, store.TryLoad(CameraAnnotationStore.AnnotationPathFor(imagePath))!.TopLeft);
        Assert.Throws<IOException>(() => store.UpdateExisting(
            Path.Combine(paths.CameraImportsRoot, "missing.png"), updated));
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
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$", Path.GetFileName(result.BatchRoot));
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
        using var source = new Bitmap(100, 140, PixelFormat.Format32bppArgb);

        Assert.True(CardGeometryService.Validate(valid).IsValid);
        Assert.False(CardGeometryService.Validate(crossed).IsValid);
        using var preview = CardGeometryService.CreatePerspectivePreview(source, valid);
        Assert.Equal(CardGeometryService.PreviewWidth, preview.Width);
        Assert.Equal(CardGeometryService.PreviewHeight, preview.Height);
    }

    [Fact]
    public async Task ModelSuggestionIsUndoableAndDoesNotWriteAnAnnotation()
    {
        var paths = new TrainingPaths(Path.Combine(_root, "suggestion-working"));
        var store = new CameraAnnotationStore(paths);
        var imagePath = Path.Combine(paths.CameraImportsRoot, "batch", "photo.png");
        WriteImage(imagePath, 100, 140, png: true);
        var suggestion = new StubSuggestionService(new ExtractionCornerSuggestion(
            "extractor-current",
            new string('a', 64),
            [new(.2, .1), new(.8, .1), new(.8, .9), new(.2, .9)],
            GeometryValid: true,
            WouldBeAccepted: false,
            RejectionReason: "presence_below_threshold",
            PresenceProbability: .42,
            AmbiguityMargin: .5,
            Elapsed: TimeSpan.FromMilliseconds(10)));
        var viewModel = new AnnotatorViewModel(
            store,
            new CameraImageImportService(store),
            new WorkspaceOperationCoordinator(),
            suggestion,
            new FakeDesktopService());

        await viewModel.RefreshAsync();
        viewModel.UseModelSuggestions = true;

        Assert.Equal(4, viewModel.Points.Count);
        Assert.True(viewModel.GeometryIsValid);
        Assert.True(viewModel.SuggestionIsWarning);
        Assert.False(File.Exists(CameraAnnotationStore.AnnotationPathFor(imagePath)));
        viewModel.UndoCommand.Execute(null);
        Assert.Empty(viewModel.Points);
    }

    [Fact]
    public async Task ReviewQueueLoadsUpdatesAndAdvancesThroughSavedAnnotations()
    {
        var paths = new TrainingPaths(Path.Combine(_root, "review-working"));
        var store = new CameraAnnotationStore(paths);
        var cardPath = Path.Combine(paths.CameraImportsRoot, "batch", "01-card.png");
        var noCardPath = Path.Combine(paths.CameraImportsRoot, "batch", "02-no-card.png");
        WriteImage(cardPath, 100, 140, png: true);
        WriteImage(noCardPath, 100, 140, png: true);
        store.SaveNew(cardPath, CreateAnnotation("01-card.png", 100, 140));
        store.SaveNew(noCardPath, new CardAnnotation
        {
            ImageFile = "02-no-card.png",
            CardPresent = false,
            ImageWidth = 100,
            ImageHeight = 140,
            SourceGroup = "batch/source",
        });
        var viewModel = new AnnotatorViewModel(
            store,
            new CameraImageImportService(store),
            new WorkspaceOperationCoordinator(),
            new StubSuggestionService(default!),
            new FakeDesktopService());

        await viewModel.ReviewAnnotatedCommand.ExecuteAsync(null);

        Assert.True(viewModel.IsReviewingAnnotations);
        Assert.Equal(2, viewModel.QueueCount);
        Assert.Equal("Review  2", viewModel.QueueSummary);
        Assert.Equal("Reviewing 1 / 2", viewModel.ReviewPosition);
        Assert.Equal("01-card.png", viewModel.CurrentFileName);
        Assert.Equal(4, viewModel.Points.Count);
        Assert.True(viewModel.GeometryIsValid);

        await viewModel.MoveNextCommand.ExecuteAsync(null);

        Assert.Equal(2, viewModel.QueueCount);
        Assert.Equal("02-no-card.png", viewModel.CurrentFileName);
        Assert.Equal("Reviewing 2 / 2", viewModel.ReviewPosition);
        Assert.Empty(viewModel.Points);
        Assert.True(viewModel.CurrentAnnotationIsNoCard);

        await viewModel.MovePreviousCommand.ExecuteAsync(null);

        Assert.Equal(2, viewModel.QueueCount);
        Assert.Equal("01-card.png", viewModel.CurrentFileName);
        Assert.Equal("Reviewing 1 / 2", viewModel.ReviewPosition);
        Assert.Equal(4, viewModel.Points.Count);

        viewModel.MovePoint(0, new(.2, .25));
        await viewModel.SaveNextCommand.ExecuteAsync(null);

        Assert.Equal(1, viewModel.QueueCount);
        Assert.Equal(new NormalizedPoint(.2, .25), store.TryLoad(
            CameraAnnotationStore.AnnotationPathFor(cardPath))!.TopLeft);
        Assert.Equal("02-no-card.png", viewModel.CurrentFileName);
        Assert.Empty(viewModel.Points);
        Assert.True(viewModel.CurrentAnnotationIsNoCard);
        Assert.Equal("No Card selected", viewModel.GeometryStatus);

        await viewModel.SkipCommand.ExecuteAsync(null);

        Assert.Equal(0, viewModel.QueueCount);
        Assert.False(viewModel.HasPhoto);
    }

    [Fact]
    public async Task SavingDuringReviewContinuesFromTheCurrentQueuePosition()
    {
        var paths = new TrainingPaths(Path.Combine(_root, "review-position-working"));
        var store = new CameraAnnotationStore(paths);
        foreach (var fileName in new[] { "01-card.png", "02-card.png", "03-card.png" })
        {
            var imagePath = Path.Combine(paths.CameraImportsRoot, "batch", fileName);
            WriteImage(imagePath, 100, 140, png: true);
            store.SaveNew(imagePath, CreateAnnotation(fileName, 100, 140));
        }
        var viewModel = new AnnotatorViewModel(
            store,
            new CameraImageImportService(store),
            new WorkspaceOperationCoordinator(),
            new StubSuggestionService(default!),
            new FakeDesktopService());
        await viewModel.ReviewAnnotatedCommand.ExecuteAsync(null);
        await viewModel.MoveNextCommand.ExecuteAsync(null);
        Assert.Equal("02-card.png", viewModel.CurrentFileName);
        Assert.Equal("Reviewing 2 / 3", viewModel.ReviewPosition);

        viewModel.MovePoint(0, new(.2, .25));
        await viewModel.SaveNextCommand.ExecuteAsync(null);

        Assert.Equal(2, viewModel.QueueCount);
        Assert.Equal("03-card.png", viewModel.CurrentFileName);
        Assert.Equal("Reviewing 3 / 3", viewModel.ReviewPosition);
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
        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(System.Drawing.Color.FromArgb(180, 180, 180));
        if (!png && orientation != 1)
        {
            var metadata = (PropertyItem)RuntimeHelpers.GetUninitializedObject(typeof(PropertyItem));
            metadata.Id = 0x0112;
            metadata.Type = 3;
            metadata.Len = 2;
            metadata.Value = BitConverter.GetBytes(orientation);
            bitmap.SetPropertyItem(metadata);
        }
        bitmap.Save(path, png ? System.Drawing.Imaging.ImageFormat.Png : System.Drawing.Imaging.ImageFormat.Jpeg);
    }

    private sealed class StubSuggestionService(ExtractionCornerSuggestion result)
        : IExtractionCornerSuggestionService
    {
        public Task<ExtractionCornerSuggestion> SuggestAsync(string imagePath, CancellationToken cancellationToken) =>
            Task.FromResult(result);

        public Task StopAsync() => Task.CompletedTask;
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
