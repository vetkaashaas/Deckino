using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Tools.Services;

namespace Deckino.Tools.ViewModels;

public partial class PhotoLibraryItemViewModel : ObservableObject
{
    private readonly Action<PhotoLibraryItemViewModel, bool> _selectionChanged;
    public CameraPhoto Photo { get; }
    public string FileName => Path.GetFileName(Photo.ImagePath);
    public string RelativePath => Photo.RelativePath;
    public string Dimensions => $"{Photo.ImageWidth:N0} × {Photo.ImageHeight:N0}";
    public string AnnotationStatus => Photo.HasInvalidAnnotation ? "Invalid annotation" : Photo.IsAnnotated ? "Annotated" : "Unannotated";
    public string CaptureCondition => string.IsNullOrWhiteSpace(Photo.CaptureCondition) ? "No condition" : Photo.CaptureCondition;
    public BitmapSource Thumbnail { get; }

    [ObservableProperty] public partial bool IsSelected { get; set; }

    public PhotoLibraryItemViewModel(CameraPhoto photo, bool selected, Action<PhotoLibraryItemViewModel, bool> selectionChanged)
    {
        Photo = photo;
        _selectionChanged = selectionChanged;
        Thumbnail = LoadThumbnail(photo.ImagePath);
        IsSelected = selected;
    }

    partial void OnIsSelectedChanged(bool value) => _selectionChanged(this, value);

    private static BitmapSource LoadThumbnail(string path)
    {
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var bitmap = new BitmapImage();
        bitmap.BeginInit();
        bitmap.CacheOption = BitmapCacheOption.OnLoad;
        bitmap.DecodePixelWidth = 280;
        bitmap.StreamSource = stream;
        bitmap.EndInit();
        bitmap.Freeze();
        return bitmap;
    }
}

public partial class PhotoLibraryViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    public const int PageSize = 60;
    private readonly CameraAnnotationStore _store;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly HashSet<string> _selectedPaths = new(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyList<CameraPhoto> _allPhotos = [];

    public override string DisplayName => "Photo Library";
    public override string Description => "Review every imported camera photo, annotation status, and owned working file.";
    public ObservableCollection<PhotoLibraryItemViewModel> PageItems { get; } = [];

    [ObservableProperty] public partial string ActiveFilter { get; private set; } = "All";
    [ObservableProperty] public partial int CurrentPage { get; private set; } = 1;
    [ObservableProperty] public partial int TotalPages { get; private set; } = 1;
    [ObservableProperty] public partial int MatchingCount { get; private set; }
    [ObservableProperty] public partial int SelectedCount { get; private set; }
    [ObservableProperty] public partial string Status { get; private set; } = "Open the library to scan imported photos.";
    [ObservableProperty] public partial bool IsBusy { get; private set; }

    public string PageLabel => $"Page {CurrentPage:N0} of {TotalPages:N0}";

    public PhotoLibraryViewModel(CameraAnnotationStore store, WorkspaceOperationCoordinator coordinator)
    {
        _store = store;
        _coordinator = coordinator;
    }

    [RelayCommand]
    private void OpenPhotosFolder()
    {
        Directory.CreateDirectory(_store.ImportsRoot);
        Process.Start(new ProcessStartInfo(_store.ImportsRoot) { UseShellExecute = true });
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        if (IsBusy) return;
        try
        {
            IsBusy = true;
            _allPhotos = await Task.Run(_store.ScanPhotos);
            _selectedPaths.RemoveWhere(path => _allPhotos.All(photo => !photo.ImagePath.Equals(path, StringComparison.OrdinalIgnoreCase)));
            CurrentPage = Math.Max(1, Math.Min(CurrentPage, CalculateTotalPages()));
            RebuildPage();
            Status = $"Loaded {_allPhotos.Count:N0} camera photos.";
        }
        catch (Exception error)
        {
            Status = $"Could not load the photo library: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private void SetFilter(string filter)
    {
        ActiveFilter = filter is "Annotated" or "Unannotated" ? filter : "All";
        CurrentPage = 1;
        RebuildPage();
    }

    [RelayCommand(CanExecute = nameof(CanPreviousPage))]
    private void PreviousPage()
    {
        CurrentPage--;
        RebuildPage();
    }

    [RelayCommand(CanExecute = nameof(CanNextPage))]
    private void NextPage()
    {
        CurrentPage++;
        RebuildPage();
    }

    [RelayCommand(CanExecute = nameof(HasMatches))]
    private void SelectAllMatching()
    {
        foreach (var photo in FilteredPhotos()) _selectedPaths.Add(photo.ImagePath);
        RebuildPage();
    }

    [RelayCommand(CanExecute = nameof(HasSelection))]
    private void ClearSelection()
    {
        _selectedPaths.Clear();
        RebuildPage();
    }

    [RelayCommand(CanExecute = nameof(HasSelection))]
    private async Task DeleteAnnotationsAsync()
    {
        var selected = SelectedPhotos();
        var annotations = selected.Count(photo => File.Exists(photo.AnnotationPath));
        if (annotations == 0)
        {
            Status = "None of the selected photos has an annotation file.";
            return;
        }
        if (MessageBox.Show(
                $"Permanently delete {annotations:N0} annotation files?\n\nThe photos will be kept and returned to the annotation queue.",
                "Delete annotations", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
        await DeleteSelectedAsync(deletePhotos: false);
    }

    [RelayCommand(CanExecute = nameof(HasSelection))]
    private async Task DeletePhotosAsync()
    {
        var selected = SelectedPhotos();
        var annotations = selected.Count(photo => File.Exists(photo.AnnotationPath));
        if (MessageBox.Show(
                $"Permanently delete {selected.Count:N0} photos and {annotations:N0} matching annotation files?\n\nThis cannot be undone.",
                "Delete photos and annotations", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
        await DeleteSelectedAsync(deletePhotos: true);
    }

    private async Task DeleteSelectedAsync(bool deletePhotos)
    {
        var selected = SelectedPhotos();
        CameraDeleteResult result;
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync(deletePhotos ? "delete camera photos" : "delete camera annotations", CancellationToken.None))
            {
                result = await Task.Run(() => _store.DeleteFiles(selected, deletePhotos));
            }
            _selectedPaths.Clear();
            await RefreshAsyncCore();
            Status = deletePhotos
                ? $"Deleted {result.DeletedPhotos:N0} photos and {result.DeletedAnnotations:N0} annotations; {result.Errors.Count:N0} failed."
                : $"Deleted {result.DeletedAnnotations:N0} annotations; {result.Errors.Count:N0} failed.";
            if (result.Errors.Count > 0)
                MessageBox.Show(string.Join(Environment.NewLine, result.Errors.Take(20)), "Some files could not be deleted",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        catch (Exception error)
        {
            Status = $"Delete operation failed: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task RefreshAsyncCore()
    {
        _allPhotos = await Task.Run(_store.ScanPhotos);
        CurrentPage = Math.Max(1, Math.Min(CurrentPage, CalculateTotalPages()));
        RebuildPage();
    }

    private void RebuildPage()
    {
        var filtered = FilteredPhotos().ToArray();
        MatchingCount = filtered.Length;
        TotalPages = Math.Max(1, (int)Math.Ceiling(filtered.Length / (double)PageSize));
        CurrentPage = Math.Clamp(CurrentPage, 1, TotalPages);
        PageItems.Clear();
        foreach (var photo in filtered.Skip((CurrentPage - 1) * PageSize).Take(PageSize))
        {
            PageItems.Add(new PhotoLibraryItemViewModel(photo, _selectedPaths.Contains(photo.ImagePath), OnSelectionChanged));
        }
        SelectedCount = _selectedPaths.Count;
        OnPropertyChanged(nameof(PageLabel));
        NotifyCommands();
    }

    private IEnumerable<CameraPhoto> FilteredPhotos() => ActiveFilter switch
    {
        "Annotated" => _allPhotos.Where(photo => photo.IsAnnotated),
        "Unannotated" => _allPhotos.Where(photo => !photo.IsAnnotated),
        _ => _allPhotos,
    };

    private IReadOnlyList<CameraPhoto> SelectedPhotos() => _allPhotos
        .Where(photo => _selectedPaths.Contains(photo.ImagePath)).ToArray();

    private void OnSelectionChanged(PhotoLibraryItemViewModel item, bool selected)
    {
        if (selected) _selectedPaths.Add(item.Photo.ImagePath);
        else _selectedPaths.Remove(item.Photo.ImagePath);
        SelectedCount = _selectedPaths.Count;
        NotifyCommands();
    }

    private int CalculateTotalPages() => Math.Max(1,
        (int)Math.Ceiling(FilteredPhotos().Count() / (double)PageSize));
    private bool CanPreviousPage() => CurrentPage > 1 && !IsBusy;
    private bool CanNextPage() => CurrentPage < TotalPages && !IsBusy;
    private bool HasMatches() => MatchingCount > 0 && !IsBusy;
    private bool HasSelection() => SelectedCount > 0 && !IsBusy;

    private void NotifyCommands()
    {
        PreviousPageCommand.NotifyCanExecuteChanged();
        NextPageCommand.NotifyCanExecuteChanged();
        SelectAllMatchingCommand.NotifyCanExecuteChanged();
        ClearSelectionCommand.NotifyCanExecuteChanged();
        DeleteAnnotationsCommand.NotifyCanExecuteChanged();
        DeletePhotosCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();
}
