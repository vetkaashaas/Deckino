using System.Collections.ObjectModel;
using System.Drawing;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

public partial class AnnotatorViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly CameraAnnotationStore _store;
    private readonly CameraImageImportService _importer;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly IExtractionCornerSuggestionService _suggestions;
    private readonly IDesktopService _desktop;
    private readonly HashSet<string> _skipped = new(StringComparer.OrdinalIgnoreCase);
    private readonly Stack<IReadOnlyList<NormalizedPoint>> _undo = new();
    private readonly Dictionary<string, int> _reviewOrdinals = new(StringComparer.OrdinalIgnoreCase);
    private List<CameraPhoto> _pendingPhotos = [];
    private CameraPhoto? _currentPhoto;
    private CardAnnotation? _currentSavedAnnotation;
    private bool _deferPreview;
    private CancellationTokenSource? _suggestionCancellation;
    private long _suggestionGeneration;
    private long _prefetchGeneration;
    private Bitmap? _currentBitmap;
    private PreparedPhoto? _prefetchedPhoto;

    public override string DisplayName => "Corner Annotator";
    public override string Description =>
        "Label new camera photos or review and adjust saved card annotations.";

    public ObservableCollection<NormalizedPoint> Points { get; } = [];

    [ObservableProperty] public partial ImageSource? CurrentImage { get; private set; }
    [ObservableProperty] public partial ImageSource? PerspectivePreview { get; private set; }
    [ObservableProperty] public partial string CurrentFileName { get; private set; } = "No unannotated photos";
    [ObservableProperty] public partial string CurrentRelativePath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string Status { get; private set; } = "Import folders or refresh the queue to begin.";
    [ObservableProperty] public partial string GeometryStatus { get; private set; } = "Add the TopLeft corner.";
    [ObservableProperty] public partial bool GeometryIsValid { get; private set; }
    [ObservableProperty] public partial int QueueCount { get; private set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial bool IsLoadingWorkspace { get; private set; }
    [ObservableProperty] public partial bool UseModelSuggestions { get; set; }
    [ObservableProperty] public partial bool IsSuggesting { get; private set; }
    [ObservableProperty] public partial bool SuggestionIsWarning { get; private set; }
    [ObservableProperty] public partial string SuggestionStatus { get; private set; } = "Model suggestions are off.";
    [ObservableProperty] public partial bool IsReviewingAnnotations { get; private set; }
    [ObservableProperty] public partial bool CurrentAnnotationIsNoCard { get; private set; }
    [ObservableProperty] public partial string ReviewPosition { get; private set; } = string.Empty;
    [ObservableProperty] public partial int CurrentImageWidth { get; private set; }
    [ObservableProperty] public partial int CurrentImageHeight { get; private set; }

    public bool HasPhoto => _currentPhoto is not null;
    public string QueueSummary => IsReviewingAnnotations
        ? $"Review  {QueueCount:N0}"
        : $"Pending  {QueueCount:N0}";
    public string NextCornerName => Points.Count < CameraAnnotationStore.CornerOrder.Count
        ? CameraAnnotationStore.CornerOrder[Points.Count]
        : "All corners placed";

    public AnnotatorViewModel(
        CameraAnnotationStore store,
        CameraImageImportService importer,
        WorkspaceOperationCoordinator coordinator,
        IExtractionCornerSuggestionService suggestions,
        IDesktopService desktop)
    {
        _store = store;
        _importer = importer;
        _coordinator = coordinator;
        _suggestions = suggestions;
        _desktop = desktop;
        Points.CollectionChanged += (_, _) => UpdateGeometry();
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        if (IsBusy) return;
        try
        {
            IsBusy = true;
            IsLoadingWorkspace = true;
            IsReviewingAnnotations = false;
            Status = "Loading annotation queue…";
            // Yield before any filesystem work so the newly selected workspace can
            // render immediately. Image enumeration and decoding run off the UI thread.
            await Task.Yield();
            await ReloadQueueAsync();
            Status = _currentPhoto is null
                ? EmptyQueueStatus()
                : $"Ready to annotate {CurrentFileName}.";
        }
        catch (Exception error)
        {
            Status = $"Could not refresh the annotation queue: {error.Message}";
        }
        finally
        {
            IsLoadingWorkspace = false;
            IsBusy = false;
        }
    }

    public void AddPoint(NormalizedPoint point)
    {
        if (!HasPhoto || Points.Count >= 4) return;
        CancelSuggestionForManualEdit();
        PushUndo();
        CurrentAnnotationIsNoCard = false;
        Points.Add(Clamp(point));
    }

    public void BeginPointEdit()
    {
        CancelSuggestionForManualEdit();
        PushUndo();
        _deferPreview = true;
    }

    public void EndPointEdit()
    {
        _deferPreview = false;
        UpdateGeometry();
    }

    public void MovePoint(int index, NormalizedPoint point)
    {
        if (index is < 0 or > 3 || index >= Points.Count) return;
        Points[index] = Clamp(point);
    }

    public void NudgePoint(int index, double deltaX, double deltaY)
    {
        if (index is < 0 or > 3 || index >= Points.Count) return;
        CancelSuggestionForManualEdit();
        PushUndo();
        MovePoint(index, new(Points[index].X + deltaX, Points[index].Y + deltaY));
    }

    [RelayCommand(CanExecute = nameof(CanSave))]
    private async Task SaveNextAsync()
    {
        if (_currentPhoto is null) return;
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync("save camera annotation", CancellationToken.None))
            {
                var annotation = BuildAnnotation(cardPresent: true);
                await Task.Run(() =>
                {
                    if (IsReviewingAnnotations)
                        _store.UpdateExisting(_currentPhoto.ImagePath, annotation);
                    else
                        _store.SaveNew(_currentPhoto.ImagePath, annotation);
                });
            }
            Status = IsReviewingAnnotations
                ? $"Updated {CurrentFileName}."
                : $"Saved {CurrentFileName}.";
            _skipped.Remove(_currentPhoto.ImagePath);
            var removedIndex = RemoveCurrentFromQueue();
            await AdvanceToNextPhotoAsync(IsReviewingAnnotations ? removedIndex : null);
        }
        catch (Exception error)
        {
            Status = $"Could not save the annotation: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private async Task MarkNoCardNextAsync()
    {
        if (_currentPhoto is null) return;
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync("save no-card annotation", CancellationToken.None))
            {
                var annotation = BuildAnnotation(cardPresent: false);
                await Task.Run(() =>
                {
                    if (IsReviewingAnnotations)
                        _store.UpdateExisting(_currentPhoto.ImagePath, annotation);
                    else
                        _store.SaveNew(_currentPhoto.ImagePath, annotation);
                });
            }
            Status = $"Marked {CurrentFileName} as no card.";
            _skipped.Remove(_currentPhoto.ImagePath);
            var removedIndex = RemoveCurrentFromQueue();
            await AdvanceToNextPhotoAsync(IsReviewingAnnotations ? removedIndex : null);
        }
        catch (Exception error)
        {
            Status = $"Could not save the no-card annotation: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private async Task SkipAsync()
    {
        if (_currentPhoto is null) return;
        try
        {
            IsBusy = true;
            int? nextReviewIndex = null;
            if (IsReviewingAnnotations)
            {
                Status = $"Reviewed {CurrentFileName} with no changes.";
                nextReviewIndex = RemoveCurrentFromQueue();
            }
            else
            {
                _skipped.Add(_currentPhoto.ImagePath);
                Status = $"Skipped {CurrentFileName} for this pass.";
            }
            await AdvanceToNextPhotoAsync(nextReviewIndex);
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanMoveNext))]
    private Task MoveNextAsync() => MoveThroughQueueAsync(1);

    [RelayCommand(CanExecute = nameof(CanMovePrevious))]
    private Task MovePreviousAsync() => MoveThroughQueueAsync(-1);

    private async Task MoveThroughQueueAsync(int offset)
    {
        if (_currentPhoto is null) return;
        var currentIndex = _pendingPhotos.IndexOf(_currentPhoto);
        var targetIndex = currentIndex + offset;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= _pendingPhotos.Count) return;

        try
        {
            IsBusy = true;
            var target = _pendingPhotos[targetIndex];
            PreparedPhoto prepared;
            if (_prefetchedPhoto is not null
                && _prefetchedPhoto.Photo.ImagePath.Equals(target.ImagePath, StringComparison.OrdinalIgnoreCase))
            {
                prepared = _prefetchedPhoto;
                _prefetchedPhoto = null;
            }
            else
            {
                CancelPrefetch();
                prepared = await Task.Run(() => PreparePhoto(target));
            }

            SetCurrentPhoto(prepared);
            Status = IsReviewingAnnotations
                ? $"Reviewing saved annotation for {CurrentFileName}."
                : $"Ready to annotate {CurrentFileName}.";
            BeginPrefetch();
        }
        catch (Exception error)
        {
            Status = $"Could not move through the annotation queue: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task ReviewAnnotatedAsync()
    {
        if (IsBusy) return;
        try
        {
            IsBusy = true;
            IsLoadingWorkspace = true;
            IsReviewingAnnotations = true;
            _skipped.Clear();
            Status = "Loading saved annotations for review…";
            await Task.Yield();
            await ReloadQueueAsync();
            Status = _currentPhoto is null
                ? EmptyQueueStatus()
                : $"Reviewing saved annotation for {CurrentFileName}.";
        }
        catch (Exception error)
        {
            Status = $"Could not load saved annotations: {error.Message}";
        }
        finally
        {
            IsLoadingWorkspace = false;
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanClear))]
    private void ClearPoints()
    {
        CancelSuggestionForManualEdit();
        PushUndo();
        Points.Clear();
    }

    [RelayCommand(CanExecute = nameof(CanUndo))]
    private void Undo()
    {
        CancelSuggestionForManualEdit();
        var snapshot = _undo.Pop();
        ReplacePoints(snapshot);
    }

    [RelayCommand]
    private async Task ImportFoldersAsync()
    {
        var selectedFolder = await _desktop.PickFolderAsync("Select a camera photo folder");
        if (selectedFolder is null) return;

        try
        {
            IsBusy = true;
            Status = "Importing and normalizing camera photos…";
            CameraImportResult result;
            using (await _coordinator.AcquireAsync("import camera photos", CancellationToken.None))
            {
                result = await Task.Run(() => _importer.Import([selectedFolder], captureCondition: null));
            }
            _skipped.Clear();
            IsReviewingAnnotations = false;
            IsLoadingWorkspace = true;
            Status = $"Imported {result.Imported:N0}; skipped {result.Skipped:N0}; failed {result.Failed:N0}.";
            if (result.Errors.Count > 0)
            {
                await _desktop.ShowMessageAsync(
                    "Camera import completed with errors",
                    string.Join(Environment.NewLine, result.Errors.Take(20)));
            }
            await ReloadQueueAsync();
        }
        catch (Exception error)
        {
            Status = $"Camera import failed: {error.Message}";
        }
        finally
        {
            IsLoadingWorkspace = false;
            IsBusy = false;
        }
    }

    private async Task ReloadQueueAsync()
    {
        var skipped = _skipped.ToHashSet(StringComparer.OrdinalIgnoreCase);
        _pendingPhotos = await Task.Run(() => _store.ScanPhotos()
                .Where(photo => IsReviewingAnnotations
                    ? photo.IsAnnotated
                    : !photo.IsAnnotated && !photo.HasInvalidAnnotation)
                .OrderBy(photo => photo.RelativePath, StringComparer.OrdinalIgnoreCase)
                .ToList());
        _reviewOrdinals.Clear();
        if (IsReviewingAnnotations)
        {
            for (var index = 0; index < _pendingPhotos.Count; index++)
                _reviewOrdinals[_pendingPhotos[index].ImagePath] = index + 1;
        }
        QueueCount = _pendingPhotos.Count;
        var next = _pendingPhotos.FirstOrDefault(photo => !skipped.Contains(photo.ImagePath));
        if (next is null && _pendingPhotos.Count > 0 && skipped.Count > 0)
        {
            _skipped.Clear();
            next = _pendingPhotos[0];
            Status = "Reached the end of this pass; returning to skipped photos.";
        }
        var prepared = next is null ? null : await Task.Run(() => PreparePhoto(next));
        SetCurrentPhoto(prepared);
        BeginPrefetch();
    }

    private async Task AdvanceToNextPhotoAsync(int? preferredIndex = null)
    {
        QueueCount = _pendingPhotos.Count;
        var next = preferredIndex.HasValue
            ? SelectReviewContinuation(preferredIndex.Value)
            : SelectNextPhoto();
        if (next is null && _pendingPhotos.Count > 0 && _skipped.Count > 0)
        {
            _skipped.Clear();
            next = _pendingPhotos[0];
            Status = "Reached the end of this pass; returning to skipped photos.";
        }

        PreparedPhoto? prepared = null;
        if (next is not null)
        {
            if (_prefetchedPhoto is not null
                && _prefetchedPhoto.Photo.ImagePath.Equals(next.ImagePath, StringComparison.OrdinalIgnoreCase))
            {
                prepared = _prefetchedPhoto;
                _prefetchedPhoto = null;
            }
            else
            {
                CancelPrefetch();
                prepared = await Task.Run(() => PreparePhoto(next));
            }
        }
        SetCurrentPhoto(prepared);
        BeginPrefetch();
    }

    private CameraPhoto? SelectNextPhoto() => _pendingPhotos.FirstOrDefault(photo =>
        !ReferenceEquals(photo, _currentPhoto)
        && !_skipped.Contains(photo.ImagePath));

    private int RemoveCurrentFromQueue()
    {
        if (_currentPhoto is null) return -1;
        var removedIndex = _pendingPhotos.FindIndex(photo => photo.ImagePath.Equals(
            _currentPhoto.ImagePath, StringComparison.OrdinalIgnoreCase));
        _pendingPhotos.RemoveAll(photo => photo.ImagePath.Equals(
            _currentPhoto.ImagePath, StringComparison.OrdinalIgnoreCase));
        QueueCount = _pendingPhotos.Count;
        return removedIndex;
    }

    private CameraPhoto? SelectReviewContinuation(int removedIndex)
    {
        if (_pendingPhotos.Count == 0 || removedIndex < 0) return null;
        return removedIndex < _pendingPhotos.Count
            ? _pendingPhotos[removedIndex]
            : _pendingPhotos[0];
    }

    private void BeginPrefetch()
    {
        CancelPrefetch();
        var next = SelectAdjacentPhoto(1) ?? SelectNextPhoto();
        if (next is null) return;
        var generation = _prefetchGeneration;
        _ = PrefetchAsync(next, generation);
    }

    private async Task PrefetchAsync(CameraPhoto photo, long generation)
    {
        try
        {
            var prepared = await Task.Run(() => PreparePhoto(photo));
            if (generation != _prefetchGeneration)
            {
                prepared.Bitmap.Dispose();
                return;
            }
            _prefetchedPhoto?.Bitmap.Dispose();
            _prefetchedPhoto = prepared;
        }
        catch
        {
            // Prefetch is an optimization. The foreground transition retries and
            // reports any real image-loading failure through its normal command path.
        }
    }

    private void CancelPrefetch()
    {
        Interlocked.Increment(ref _prefetchGeneration);
        _prefetchedPhoto?.Bitmap.Dispose();
        _prefetchedPhoto = null;
    }

    private void SetCurrentPhoto(PreparedPhoto? prepared)
    {
        var photo = prepared?.Photo;
        CancelPendingSuggestion();
        _currentBitmap?.Dispose();
        _currentBitmap = null;
        _currentPhoto = photo;
        _currentSavedAnnotation = prepared?.SavedAnnotation;
        CurrentAnnotationIsNoCard = false;
        Points.Clear();
        _undo.Clear();
        PerspectivePreview = null;
        if (photo is null)
        {
            CurrentImage = null;
            CurrentImageWidth = 0;
            CurrentImageHeight = 0;
            CurrentFileName = IsReviewingAnnotations
                ? "No saved annotations"
                : "No unannotated photos";
            CurrentRelativePath = string.Empty;
            GeometryStatus = IsReviewingAnnotations
                ? "There are no saved annotations to review."
                : "Import more photos or remove an annotation in Photo Library.";
        }
        else
        {
            _currentBitmap = prepared!.Bitmap;
            CurrentImage = Application.Current is null
                ? null
                : ImageSourceFactory.FromBytesUnlocked(prepared.ImageBytes);
            CurrentImageWidth = photo.ImageWidth;
            CurrentImageHeight = photo.ImageHeight;
            CurrentFileName = Path.GetFileName(photo.ImagePath);
            CurrentRelativePath = photo.RelativePath;
            if (_currentSavedAnnotation is { CardPresent: false })
            {
                CurrentAnnotationIsNoCard = true;
                GeometryStatus = "No Card selected";
            }
            else if (_currentSavedAnnotation is not null)
            {
                ReplacePoints(_currentSavedAnnotation.Points.OfType<NormalizedPoint>().ToArray());
            }
            else
            {
                GeometryStatus = "Add the TopLeft corner.";
            }
        }
        OnPropertyChanged(nameof(HasPhoto));
        UpdateReviewPosition();
        NotifyCommands();
        if (photo is not null && UseModelSuggestions && !IsReviewingAnnotations)
            _ = SuggestCurrentPhotoAsync(photo);
    }

    private async Task SuggestCurrentPhotoAsync(CameraPhoto photo)
    {
        if (!UseModelSuggestions
            || IsReviewingAnnotations
            || Points.Count > 0
            || !ReferenceEquals(_currentPhoto, photo)) return;
        CancelPendingSuggestion();
        var generation = _suggestionGeneration;
        var cancellation = new CancellationTokenSource();
        _suggestionCancellation = cancellation;
        IsSuggesting = true;
        SuggestionIsWarning = false;
        SuggestionStatus = "Finding card corners with the current extraction model…";
        try
        {
            var result = await _suggestions.SuggestAsync(photo.ImagePath, cancellation.Token);
            if (cancellation.IsCancellationRequested
                || generation != _suggestionGeneration
                || !UseModelSuggestions
                || !ReferenceEquals(_currentPhoto, photo)
                || Points.Count > 0)
                return;

            var validation = result.Corners is null
                ? new GeometryValidation(false, result.RejectionReason ?? "The model did not return four usable corners.")
                : CardGeometryService.Validate(result.Corners);
            if (result.Corners is null || !validation.IsValid)
            {
                SuggestionIsWarning = true;
                SuggestionStatus = $"No usable suggestion from {ShortVersion(result.ModelVersion)}: {validation.Message}";
                return;
            }

            PushUndo();
            ReplacePoints(result.Corners);
            SuggestionIsWarning = !result.WouldBeAccepted;
            SuggestionStatus = result.WouldBeAccepted
                ? $"Suggested by {ShortVersion(result.ModelVersion)} · confidence {result.PresenceProbability:P1}. Review, adjust, then save."
                : $"Low-confidence suggestion from {ShortVersion(result.ModelVersion)} · confidence {result.PresenceProbability:P1} · {FriendlyReason(result.RejectionReason)}. Review carefully before saving.";
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            if (generation != _suggestionGeneration) return;
            UseModelSuggestions = false;
            SuggestionIsWarning = true;
            SuggestionStatus = $"Model suggestions were turned off: {error.Message}";
        }
        finally
        {
            if (ReferenceEquals(_suggestionCancellation, cancellation))
            {
                _suggestionCancellation = null;
                IsSuggesting = false;
            }
            cancellation.Dispose();
        }
    }

    private void CancelPendingSuggestion()
    {
        Interlocked.Increment(ref _suggestionGeneration);
        _suggestionCancellation?.Cancel();
        _suggestionCancellation = null;
        IsSuggesting = false;
    }

    private void CancelSuggestionForManualEdit()
    {
        CancelPendingSuggestion();
        if (!UseModelSuggestions) return;
        SuggestionIsWarning = false;
        SuggestionStatus = "Manual points kept. Model suggestions will run again on the next photo.";
    }

    partial void OnUseModelSuggestionsChanged(bool value)
    {
        if (!value)
        {
            CancelPendingSuggestion();
            SuggestionIsWarning = false;
            SuggestionStatus = "Model suggestions are off.";
            _ = _suggestions.StopAsync();
            return;
        }

        SuggestionIsWarning = false;
        if (IsReviewingAnnotations)
            SuggestionStatus = "Saved annotations are loaded as-is during review.";
        else if (_currentPhoto is null)
            SuggestionStatus = "Model suggestions are on and will run when a photo is available.";
        else if (Points.Count > 0)
            SuggestionStatus = "Model suggestions are on and will run automatically on the next photo. Existing points will not be replaced.";
        else
            _ = SuggestCurrentPhotoAsync(_currentPhoto);
    }

    private static string ShortVersion(string version) => version.Length <= 28 ? version : version[..28] + "…";

    private static string FriendlyReason(string? reason) => reason switch
    {
        "presence_below_threshold" => "below the serving confidence threshold",
        "ambiguous_card_geometry" => "ambiguous corner candidates",
        "invalid_quadrilateral" => "invalid predicted geometry",
        null or "" => "production checks did not accept it",
        _ => reason.Replace('_', ' '),
    };

    private CardAnnotation BuildAnnotation(bool cardPresent) => new()
    {
        SchemaVersion = _currentSavedAnnotation?.SchemaVersion ?? 1,
        DatasetVersion = _currentSavedAnnotation?.DatasetVersion ?? "corners-v1",
        ImageFile = Path.GetFileName(_currentPhoto!.ImagePath),
        CardPresent = cardPresent,
        CornerOrder = _currentSavedAnnotation?.CornerOrder ?? CameraAnnotationStore.CornerOrder,
        TopLeft = cardPresent ? Points[0] : null,
        TopRight = cardPresent ? Points[1] : null,
        BottomRight = cardPresent ? Points[2] : null,
        BottomLeft = cardPresent ? Points[3] : null,
        ImageWidth = _currentPhoto.ImageWidth,
        ImageHeight = _currentPhoto.ImageHeight,
        SourceGroup = _currentPhoto.SourceGroup,
        CaptureCondition = _currentPhoto.CaptureCondition,
        Split = _currentSavedAnnotation?.Split,
    };

    private void UpdateGeometry()
    {
        OnPropertyChanged(nameof(NextCornerName));
        var validation = CardGeometryService.Validate(Points);
        GeometryIsValid = validation.IsValid;
        GeometryStatus = CurrentAnnotationIsNoCard && Points.Count == 0
            ? "No Card selected"
            : Points.Count < 4 ? $"Next: {NextCornerName}" : validation.Message;
        if (!_deferPreview
            && validation.IsValid
            && _currentBitmap is not null
            && Application.Current is not null)
        {
            try
            {
                PerspectivePreview = ImageSourceFactory.FromBitmap(
                    CardGeometryService.CreatePerspectivePreview(_currentBitmap, Points));
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException)
            {
                GeometryIsValid = false;
                GeometryStatus = $"Perspective preview failed: {error.Message}";
                PerspectivePreview = null;
            }
        }
        else if (!_deferPreview)
        {
            PerspectivePreview = null;
        }
        NotifyCommands();
    }

    private void PushUndo() => _undo.Push(Points.ToArray());

    private void ReplacePoints(IReadOnlyList<NormalizedPoint> points)
    {
        Points.Clear();
        foreach (var point in points) Points.Add(point);
    }

    private static Bitmap LoadBitmap(string path)
    {
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var loaded = new Bitmap(stream);
        return new Bitmap(loaded);
    }

    private PreparedPhoto PreparePhoto(CameraPhoto photo)
    {
        var bitmap = LoadBitmap(photo.ImagePath);
        try
        {
            var savedAnnotation = IsReviewingAnnotations
                ? _store.TryLoad(photo.AnnotationPath)
                : null;
            return new PreparedPhoto(
                photo,
                bitmap,
                ImageSourceFactory.ReadAllBytesUnlocked(photo.ImagePath),
                savedAnnotation);
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    private sealed record PreparedPhoto(
        CameraPhoto Photo,
        Bitmap Bitmap,
        byte[] ImageBytes,
        CardAnnotation? SavedAnnotation);

    private bool CanSave() => HasPhoto && GeometryIsValid && !IsBusy;
    private bool CanUsePhoto() => HasPhoto && !IsBusy;
    private bool CanClear() => Points.Count > 0 && !IsBusy;
    private bool CanUndo() => _undo.Count > 0 && !IsBusy;
    private bool CanMoveNext() => SelectAdjacentPhoto(1) is not null && !IsBusy;
    private bool CanMovePrevious() => SelectAdjacentPhoto(-1) is not null && !IsBusy;

    private CameraPhoto? SelectAdjacentPhoto(int offset)
    {
        if (_currentPhoto is null) return null;
        var currentIndex = _pendingPhotos.IndexOf(_currentPhoto);
        var targetIndex = currentIndex + offset;
        return currentIndex >= 0 && targetIndex >= 0 && targetIndex < _pendingPhotos.Count
            ? _pendingPhotos[targetIndex]
            : null;
    }

    private void NotifyCommands()
    {
        SaveNextCommand.NotifyCanExecuteChanged();
        MarkNoCardNextCommand.NotifyCanExecuteChanged();
        SkipCommand.NotifyCanExecuteChanged();
        ClearPointsCommand.NotifyCanExecuteChanged();
        UndoCommand.NotifyCanExecuteChanged();
        MoveNextCommand.NotifyCanExecuteChanged();
        MovePreviousCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();

    partial void OnQueueCountChanged(int value) => OnPropertyChanged(nameof(QueueSummary));

    partial void OnIsReviewingAnnotationsChanged(bool value) =>
        UpdateReviewModeProperties();

    private void UpdateReviewModeProperties()
    {
        OnPropertyChanged(nameof(QueueSummary));
        UpdateReviewPosition();
    }

    private void UpdateReviewPosition()
    {
        ReviewPosition = IsReviewingAnnotations
            && _currentPhoto is not null
            && _reviewOrdinals.TryGetValue(_currentPhoto.ImagePath, out var ordinal)
                ? $"Reviewing {ordinal:N0} / {_reviewOrdinals.Count:N0}"
                : string.Empty;
    }

    private string EmptyQueueStatus() => IsReviewingAnnotations
        ? "No saved annotations are available to review."
        : "No unannotated photos are waiting.";

    private static NormalizedPoint Clamp(NormalizedPoint point) =>
        new(Math.Clamp(point.X, 0, 1), Math.Clamp(point.Y, 0, 1));
}
