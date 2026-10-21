using System.Collections.ObjectModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Bridge;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

public partial class PhotoLibraryItemViewModel : ObservableObject
{
    private readonly Action<PhotoLibraryItemViewModel, bool> _selectionChanged;
    private bool _rebinding;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(FileName), nameof(RelativePath), nameof(Dimensions), nameof(AnnotationStatus), nameof(CaptureCondition), nameof(ThumbnailUrl))]
    public partial CameraPhoto Photo { get; private set; }
    public string FileName => Path.GetFileName(Photo.ImagePath);
    public string RelativePath => Photo.RelativePath;
    public string Dimensions => $"{Photo.ImageWidth:N0} × {Photo.ImageHeight:N0}";
    public string AnnotationStatus => Photo.HasInvalidAnnotation ? "Invalid annotation" : Photo.IsAnnotated ? "Annotated" : "Unannotated";
    public string CaptureCondition => string.IsNullOrWhiteSpace(Photo.CaptureCondition) ? "No condition" : Photo.CaptureCondition;
    public string ThumbnailUrl => Images.Thumbnail(Photo);

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

    // Tiles are reused from page to page, so paging only rebinds them instead of rebuilding 60 view trees.
    public void Show(CameraPhoto photo, bool selected)
    {
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
    private readonly CameraImageImportService _importer;
    private readonly HashSet<string> _selectedPaths = new(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyList<CameraPhoto> _allPhotos = [];
    private CancellationTokenSource? _thumbnailLoad;

    public override string DisplayName => "Photo Library";
    public override string Description => "Review every imported camera photo, annotation status, and owned working file.";
    public ObservableCollection<PhotoLibraryItemViewModel> PageItems { get; } = [];

    [ObservableProperty] public partial string ActiveFilter { get; private set; } = "All";
    // File search: several names or paths separated by spaces, commas or new lines match any of them.
    [ObservableProperty] public partial string SearchText { get; set; } = "";
    [ObservableProperty] public partial int CurrentPage { get; private set; } = 1;
    [ObservableProperty] public partial int TotalPages { get; private set; } = 1;
    [ObservableProperty] public partial int MatchingCount { get; private set; }
    [ObservableProperty] public partial int SelectedCount { get; private set; }
    [ObservableProperty] public partial string Status { get; private set; } = "Open the library to scan imported photos.";
    [ObservableProperty] public partial bool IsBusy { get; private set; }

    public PhotoLibraryViewModel(
        CameraAnnotationStore store,
        WorkspaceOperationCoordinator coordinator,
        IDesktopService desktop,
        CameraImageImportService importer)
    {
        _store = store;
        _coordinator = coordinator;
        _desktop = desktop;
        _importer = importer;
    }

    // Photos or folders dropped from Explorer: the same import as Corner Annotator's, without a capture condition.
    public async Task ImportDroppedAsync(IReadOnlyList<string> paths)
    {
        if (IsBusy || paths.Count == 0) return;
        try
        {
            IsBusy = true;
            Status = "Importing and normalizing dropped photos…";
            CameraImportResult result;
            using (await _coordinator.AcquireAsync("import camera photos", CancellationToken.None))
            {
                result = await Task.Run(() => _importer.Import(paths, null));
            }
            await RefreshAsyncCore();
            Status = $"Imported {result.Imported:N0}; skipped {result.Skipped:N0}; failed {result.Failed:N0}.";
            if (result.Errors.Count > 0)
                await _desktop.ShowMessageAsync(
                    "Photo import completed with errors",
                    string.Join(Environment.NewLine, result.Errors.Take(20)));
        }
        catch (Exception error)
        {
            Status = $"Photo import failed: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
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

    partial void OnSearchTextChanged(string value)
    {
        CurrentPage = 1;
        RebuildPage();
    }

    [RelayCommand]
    private void GoToPage(int page)
    {
        if (IsBusy) return;
        CurrentPage = Math.Clamp(page, 1, TotalPages);
        RebuildPage();
    }

    // The page names the tile by its photo: tiles are reused, so a position could be another photo by now.
    [RelayCommand]
    private void ToggleSelected(PhotoLibraryItemViewModel item) => item.IsSelected = !item.IsSelected;

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
        await DeleteSelectedAsync(deletePhotos: false, deleteIdentities: false);
    }

    [RelayCommand(CanExecute = nameof(HasSelection))]
    private async Task DeleteAnnotationsAndIdentitiesAsync()
    {
        var selected = SelectedPhotos();
        var annotations = selected.Count(photo => File.Exists(photo.AnnotationPath));
        var identities = selected.Count(photo => File.Exists(photo.IdentityPath));
        if (annotations + identities == 0)
        {
            Status = "None of the selected photos has an annotation or identity file.";
            return;
        }
        if (!await _desktop.ConfirmAsync(
                "Delete annotations and identities",
                $"Permanently delete {annotations:N0} annotation files and {identities:N0} card identity files?\n\n" +
                "The photos will be kept and returned to the Corner Annotator and Identify Card queues.",
                "Delete annotations + identities")) return;
        await DeleteSelectedAsync(deletePhotos: false, deleteIdentities: true);
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
        await DeleteSelectedAsync(deletePhotos: true, deleteIdentities: true);
    }

    private async Task DeleteSelectedAsync(bool deletePhotos, bool deleteIdentities)
    {
        var selected = SelectedPhotos();
        CameraDeleteResult result;
        try
        {
            IsBusy = true;
            var operation = deletePhotos ? "delete camera photos"
                : deleteIdentities ? "delete camera annotations and identities" : "delete camera annotations";
            using (await _coordinator.AcquireAsync(operation, CancellationToken.None))
            {
                result = await Task.Run(() => _store.DeleteFiles(selected, deletePhotos, deleteIdentities));
            }
            _selectedPaths.Clear();
            await RefreshAsyncCore();
            Status = deletePhotos
                ? $"Deleted {result.DeletedPhotos:N0} photos and {result.DeletedAnnotations:N0} annotations; {result.Errors.Count:N0} failed."
                : deleteIdentities
                    ? $"Deleted {result.DeletedAnnotations:N0} annotations and {result.DeletedIdentities:N0} card identities; {result.Errors.Count:N0} failed."
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
        NotifyCommands();
        WarmNextPage(filtered.Skip(CurrentPage * PageSize).Take(PageSize).Select(photo => photo.ImagePath).ToArray());
    }

    // The page's tiles fetch their thumbnails themselves; this warms the disk cache for the next page so "Next"
    // finds its thumbnails ready. Moving to another page cancels the rest.
    private void WarmNextPage(string[] nextPage)
    {
        _thumbnailLoad?.Cancel();
        var cancellation = _thumbnailLoad = new CancellationTokenSource();
        var prefetchOptions = new ParallelOptions { CancellationToken = cancellation.Token, MaxDegreeOfParallelism = 2 };
        _ = Task.Run(async () =>
        {
            try
            {
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

    private IEnumerable<CameraPhoto> FilteredPhotos()
    {
        IEnumerable<CameraPhoto> photos = ActiveFilter switch
        {
            "Annotated" => _allPhotos.Where(photo => photo.IsAnnotated),
            "Unannotated" => _allPhotos.Where(photo => !photo.IsAnnotated),
            _ => _allPhotos,
        };
        var terms = SearchText.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .SelectMany(term => term.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries)).ToArray();
        // The relative path ends in the file name, so a pasted name or path (as shown on a tile) both match.
        return terms.Length == 0 ? photos : photos.Where(photo =>
            terms.Any(term => photo.RelativePath.Contains(term, StringComparison.OrdinalIgnoreCase)));
    }

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
    private bool HasMatches() => MatchingCount > 0 && !IsBusy;
    private bool HasSelection() => SelectedCount > 0 && !IsBusy;

    private void NotifyCommands()
    {
        SelectAllMatchingCommand.NotifyCanExecuteChanged();
        ClearSelectionCommand.NotifyCanExecuteChanged();
        DeleteAnnotationsCommand.NotifyCanExecuteChanged();
        DeleteAnnotationsAndIdentitiesCommand.NotifyCanExecuteChanged();
        DeletePhotosCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();
}
