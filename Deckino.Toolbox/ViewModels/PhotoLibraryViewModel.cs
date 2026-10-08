using System.Collections.ObjectModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

public partial class PhotoLibraryItemViewModel : ObservableObject
{
    private readonly Action<PhotoLibraryItemViewModel, bool> _selectionChanged;
    private bool _rebinding;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(FileName), nameof(RelativePath), nameof(Dimensions), nameof(AnnotationStatus), nameof(CaptureCondition))]
    public partial CameraPhoto Photo { get; private set; }
    public string FileName => Path.GetFileName(Photo.ImagePath);
    public string RelativePath => Photo.RelativePath;
    public string Dimensions => $"{Photo.ImageWidth:N0} × {Photo.ImageHeight:N0}";
    public string AnnotationStatus => Photo.HasInvalidAnnotation ? "Invalid annotation" : Photo.IsAnnotated ? "Annotated" : "Unannotated";
    public string CaptureCondition => string.IsNullOrWhiteSpace(Photo.CaptureCondition) ? "No condition" : Photo.CaptureCondition;
    // Filled in by PhotoLibraryViewModel after the page is shown.
    [ObservableProperty] public partial ImageSource? Thumbnail { get; set; }

    [ObservableProperty] public partial bool IsSelected { get; set; }

    public PhotoLibraryItemViewModel(CameraPhoto photo, bool selected, Action<PhotoLibraryItemViewModel, bool> selectionChanged)
    {
        Photo = photo;
        _selectionChanged = selectionChanged;
        IsSelected = selected;
    }

    partial void OnIsSelectedChanged(bool value)
    {
        if (!_rebinding) _selectionChanged(this, value);
    }

    [RelayCommand]
    private void ToggleSelected() => IsSelected = !IsSelected;

    // Same file, same version: the thumbnail already on the tile is still right.
    public bool ShowsImageOf(CameraPhoto photo) =>
        photo.ImagePath == Photo.ImagePath && photo.ModifiedUtc == Photo.ModifiedUtc && photo.FileLength == Photo.FileLength;

    // Tiles are reused from page to page, so paging only rebinds them instead of rebuilding 60 view trees.
    public void Show(CameraPhoto photo, bool selected)
    {
        if (!ShowsImageOf(photo)) Thumbnail = null;
        Photo = photo;
        // The selection already comes from the library's set, so it isn't reported back per tile.
        _rebinding = true;
        IsSelected = selected;
        _rebinding = false;
    }
}

public partial class PhotoLibraryViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    public const int PageSize = 60;
    private readonly CameraAnnotationStore _store;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly IDesktopService _desktop;
    private readonly HashSet<string> _selectedPaths = new(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyList<CameraPhoto> _allPhotos = [];
    private CancellationTokenSource? _thumbnailLoad;

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

    public PhotoLibraryViewModel(
        CameraAnnotationStore store,
        WorkspaceOperationCoordinator coordinator,
        IDesktopService desktop)
    {
        _store = store;
        _coordinator = coordinator;
        _desktop = desktop;
    }

    [RelayCommand]
    private void OpenPhotosFolder()
    {
        Directory.CreateDirectory(_store.ImportsRoot);
        _desktop.OpenFolder(_store.ImportsRoot);
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        if (IsBusy) return;
        try
        {
            IsBusy = true;
            var skipped = 0;
            _allPhotos = await Task.Run(() => _store.ScanPhotos(out skipped));
            var paths = _allPhotos.Select(photo => photo.ImagePath).ToHashSet(StringComparer.OrdinalIgnoreCase);
            _selectedPaths.RemoveWhere(path => !paths.Contains(path));
            CurrentPage = Math.Max(1, Math.Min(CurrentPage, CalculateTotalPages()));
            RebuildPage();
            Status = skipped == 0
                ? $"Loaded {_allPhotos.Count:N0} camera photos."
                : $"Loaded {_allPhotos.Count:N0} camera photos; skipped {skipped:N0} unreadable image files.";
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
    private void FirstPage()
    {
        CurrentPage = 1;
        RebuildPage();
    }

    [RelayCommand(CanExecute = nameof(CanNextPage))]
    private void LastPage()
    {
        CurrentPage = TotalPages;
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
        if (!await _desktop.ConfirmAsync(
                "Delete annotations",
                $"Permanently delete {annotations:N0} annotation files?\n\nThe photos will be kept and returned to the annotation queue.",
                "Delete annotations")) return;
        await DeleteSelectedAsync(deletePhotos: false);
    }

    [RelayCommand(CanExecute = nameof(HasSelection))]
    private async Task DeletePhotosAsync()
    {
        var selected = SelectedPhotos();
        var annotations = selected.Count(photo => File.Exists(photo.AnnotationPath));
        if (!await _desktop.ConfirmAsync(
                "Delete photos and annotations",
                $"Permanently delete {selected.Count:N0} photos and {annotations:N0} matching annotation files?\n\nThis cannot be undone.",
                "Delete permanently")) return;
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
                await _desktop.ShowMessageAsync(
                    "Some files could not be deleted",
                    string.Join(Environment.NewLine, result.Errors.Take(20)));
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
        var page = filtered.Skip((CurrentPage - 1) * PageSize).Take(PageSize).ToArray();
        for (var i = 0; i < page.Length; i++)
        {
            var selected = _selectedPaths.Contains(page[i].ImagePath);
            if (i < PageItems.Count) PageItems[i].Show(page[i], selected);
            else PageItems.Add(new PhotoLibraryItemViewModel(page[i], selected, OnSelectionChanged));
        }
        while (PageItems.Count > page.Length) PageItems.RemoveAt(PageItems.Count - 1);
        SelectedCount = _selectedPaths.Count;
        OnPropertyChanged(nameof(PageLabel));
        NotifyCommands();
        LoadThumbnails(
            PageItems.Where(item => item.Thumbnail is null).ToArray(),
            filtered.Skip(CurrentPage * PageSize).Take(PageSize).Select(photo => photo.ImagePath).ToArray());
    }

    // Loads the page's missing thumbnails off the UI thread, then warms the disk cache for the next page so
    // "Next" finds its thumbnails ready. Skipping to another page cancels the rest.
    private void LoadThumbnails(PhotoLibraryItemViewModel[] items, string[] nextPage)
    {
        _thumbnailLoad?.Cancel();
        var cancellation = _thumbnailLoad = new CancellationTokenSource();
        // A thumbnail miss decodes a full-size photo; half the cores keeps memory and the UI in check.
        var options = new ParallelOptions { CancellationToken = cancellation.Token, MaxDegreeOfParallelism = Math.Max(1, Environment.ProcessorCount / 2) };
        var prefetchOptions = new ParallelOptions { CancellationToken = cancellation.Token, MaxDegreeOfParallelism = 2 };
        _ = Task.Run(async () =>
        {
            try
            {
                await Parallel.ForEachAsync(items, options, (item, token) =>
                {
                    var photo = item.Photo;
                    try
                    {
                        var source = ImageSourceFactory.FromBytesUnlocked(_store.LoadThumbnail(photo.ImagePath));
                        // The tile may have been reused for another photo, or a newer version of this one, meanwhile.
                        MainThread.BeginInvokeOnMainThread(() =>
                        {
                            if (item.ShowsImageOf(photo)) item.Thumbnail = source;
                        });
                    }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or OutOfMemoryException)
                    {
                        // Missing or unreadable photo: leave the tile blank.
                    }
                    return ValueTask.CompletedTask;
                });
                await Parallel.ForEachAsync(nextPage, prefetchOptions, (path, token) =>
                {
                    try { _store.WarmThumbnail(path); }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or OutOfMemoryException) { }
                    return ValueTask.CompletedTask;
                });
            }
            catch (OperationCanceledException)
            {
            }
        });
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
        FirstPageCommand.NotifyCanExecuteChanged();
        PreviousPageCommand.NotifyCanExecuteChanged();
        NextPageCommand.NotifyCanExecuteChanged();
        LastPageCommand.NotifyCanExecuteChanged();
        SelectAllMatchingCommand.NotifyCanExecuteChanged();
        ClearSelectionCommand.NotifyCanExecuteChanged();
        DeleteAnnotationsCommand.NotifyCanExecuteChanged();
        DeletePhotosCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();
}
