using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Tools.Services;
using Microsoft.Win32;

namespace Deckino.Tools.ViewModels;

public partial class AnnotatorViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly CameraAnnotationStore _store;
    private readonly CameraImageImportService _importer;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly HashSet<string> _skipped = new(StringComparer.OrdinalIgnoreCase);
    private readonly Stack<IReadOnlyList<NormalizedPoint>> _undo = new();
    private CameraPhoto? _currentPhoto;
    private bool _deferPreview;

    public override string DisplayName => "Corner Annotator";
    public override string Description =>
        "Import owned camera photos and label four ordered card corners for the extraction dataset.";

    public ObservableCollection<NormalizedPoint> Points { get; } = [];

    [ObservableProperty] public partial BitmapSource? CurrentImage { get; private set; }
    [ObservableProperty] public partial BitmapSource? PerspectivePreview { get; private set; }
    [ObservableProperty] public partial string CurrentFileName { get; private set; } = "No unannotated photos";
    [ObservableProperty] public partial string CurrentRelativePath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string Status { get; private set; } = "Import folders or refresh the queue to begin.";
    [ObservableProperty] public partial string GeometryStatus { get; private set; } = "Add the TopLeft corner.";
    [ObservableProperty] public partial bool GeometryIsValid { get; private set; }
    [ObservableProperty] public partial int QueueCount { get; private set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }

    public bool HasPhoto => _currentPhoto is not null;
    public string NextCornerName => Points.Count < CameraAnnotationStore.CornerOrder.Count
        ? CameraAnnotationStore.CornerOrder[Points.Count]
        : "All corners placed";

    public AnnotatorViewModel(
        CameraAnnotationStore store,
        CameraImageImportService importer,
        WorkspaceOperationCoordinator coordinator)
    {
        _store = store;
        _importer = importer;
        _coordinator = coordinator;
        Points.CollectionChanged += (_, _) => UpdateGeometry();
    }

    [RelayCommand]
    public Task RefreshAsync()
    {
        if (IsBusy) return Task.CompletedTask;
        try
        {
            IsBusy = true;
            LoadNextPhoto();
        }
        catch (Exception error)
        {
            Status = $"Could not refresh the annotation queue: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
        return Task.CompletedTask;
    }

    public void AddPoint(NormalizedPoint point)
    {
        if (!HasPhoto || Points.Count >= 4) return;
        PushUndo();
        Points.Add(Clamp(point));
    }

    public void BeginPointEdit()
    {
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
        PushUndo();
        MovePoint(index, new(Points[index].X + deltaX, Points[index].Y + deltaY));
    }

    [RelayCommand(CanExecute = nameof(CanSave))]
    private async Task SaveNextAsync()
    {
        if (_currentPhoto is null || CurrentImage is null) return;
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync("save camera annotation", CancellationToken.None))
            {
                var annotation = BuildAnnotation(cardPresent: true);
                await Task.Run(() => _store.SaveNew(_currentPhoto.ImagePath, annotation));
            }
            Status = $"Saved {CurrentFileName}.";
            _skipped.Remove(_currentPhoto.ImagePath);
            LoadNextPhoto();
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
                await Task.Run(() => _store.SaveNew(_currentPhoto.ImagePath, annotation));
            }
            Status = $"Marked {CurrentFileName} as no card.";
            _skipped.Remove(_currentPhoto.ImagePath);
            LoadNextPhoto();
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
    private void Skip()
    {
        if (_currentPhoto is null) return;
        _skipped.Add(_currentPhoto.ImagePath);
        Status = $"Skipped {CurrentFileName} for this pass.";
        LoadNextPhoto();
    }

    [RelayCommand(CanExecute = nameof(CanClear))]
    private void ClearPoints()
    {
        PushUndo();
        Points.Clear();
    }

    [RelayCommand(CanExecute = nameof(CanUndo))]
    private void Undo()
    {
        var snapshot = _undo.Pop();
        ReplacePoints(snapshot);
    }

    [RelayCommand]
    private async Task ImportFoldersAsync()
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Select camera photo folders",
            Multiselect = true,
        };
        if (dialog.ShowDialog() != true || dialog.FolderNames.Length == 0) return;

        try
        {
            IsBusy = true;
            Status = "Importing and normalizing camera photos…";
            CameraImportResult result;
            using (await _coordinator.AcquireAsync("import camera photos", CancellationToken.None))
            {
                result = await Task.Run(() => _importer.Import(dialog.FolderNames, captureCondition: null));
            }
            _skipped.Clear();
            Status = $"Imported {result.Imported:N0}; skipped {result.Skipped:N0}; failed {result.Failed:N0}.";
            if (result.Errors.Count > 0)
            {
                MessageBox.Show(string.Join(Environment.NewLine, result.Errors.Take(20)),
                    "Camera import completed with errors", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            LoadNextPhoto();
        }
        catch (Exception error)
        {
            Status = $"Camera import failed: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private void LoadNextPhoto()
    {
        var pending = _store.ScanPhotos()
            .Where(photo => !photo.IsAnnotated && !photo.HasInvalidAnnotation)
            .OrderBy(photo => photo.RelativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        QueueCount = pending.Length;
        var next = pending.FirstOrDefault(photo => !_skipped.Contains(photo.ImagePath));
        if (next is null && pending.Length > 0 && _skipped.Count > 0)
        {
            _skipped.Clear();
            next = pending[0];
            Status = "Reached the end of this pass; returning to skipped photos.";
        }
        SetCurrentPhoto(next);
    }

    private void SetCurrentPhoto(CameraPhoto? photo)
    {
        _currentPhoto = photo;
        Points.Clear();
        _undo.Clear();
        PerspectivePreview = null;
        if (photo is null)
        {
            CurrentImage = null;
            CurrentFileName = "No unannotated photos";
            CurrentRelativePath = string.Empty;
            GeometryStatus = "Import more photos or remove an annotation in Photo Library.";
        }
        else
        {
            CurrentImage = LoadBitmap(photo.ImagePath);
            CurrentFileName = Path.GetFileName(photo.ImagePath);
            CurrentRelativePath = photo.RelativePath;
            GeometryStatus = "Add the TopLeft corner.";
        }
        OnPropertyChanged(nameof(HasPhoto));
        NotifyCommands();
    }

    private CardAnnotation BuildAnnotation(bool cardPresent) => new()
    {
        ImageFile = Path.GetFileName(_currentPhoto!.ImagePath),
        CardPresent = cardPresent,
        TopLeft = cardPresent ? Points[0] : null,
        TopRight = cardPresent ? Points[1] : null,
        BottomRight = cardPresent ? Points[2] : null,
        BottomLeft = cardPresent ? Points[3] : null,
        ImageWidth = _currentPhoto.ImageWidth,
        ImageHeight = _currentPhoto.ImageHeight,
        SourceGroup = _currentPhoto.SourceGroup,
        CaptureCondition = _currentPhoto.CaptureCondition,
        Split = null,
    };

    private void UpdateGeometry()
    {
        OnPropertyChanged(nameof(NextCornerName));
        var validation = CardGeometryService.Validate(Points);
        GeometryIsValid = validation.IsValid;
        GeometryStatus = Points.Count < 4 ? $"Next: {NextCornerName}" : validation.Message;
        if (!_deferPreview && validation.IsValid && CurrentImage is not null)
        {
            try
            {
                PerspectivePreview = CardGeometryService.CreatePerspectivePreview(CurrentImage, Points);
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

    private static BitmapSource LoadBitmap(string path)
    {
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var bitmap = BitmapFrame.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        bitmap.Freeze();
        return bitmap;
    }

    private bool CanSave() => HasPhoto && GeometryIsValid && !IsBusy;
    private bool CanUsePhoto() => HasPhoto && !IsBusy;
    private bool CanClear() => Points.Count > 0 && !IsBusy;
    private bool CanUndo() => _undo.Count > 0 && !IsBusy;

    private void NotifyCommands()
    {
        SaveNextCommand.NotifyCanExecuteChanged();
        MarkNoCardNextCommand.NotifyCanExecuteChanged();
        SkipCommand.NotifyCanExecuteChanged();
        ClearPointsCommand.NotifyCanExecuteChanged();
        UndoCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();

    private static NormalizedPoint Clamp(NormalizedPoint point) =>
        new(Math.Clamp(point.X, 0, 1), Math.Clamp(point.Y, 0, 1));
}
