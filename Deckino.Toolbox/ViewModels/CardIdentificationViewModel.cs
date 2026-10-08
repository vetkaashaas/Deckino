using System.Collections.ObjectModel;
using System.Drawing;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

// Labels which card a camera photo shows, writing <photo>._identity.json. The queue is every photo with a card
// in known corners (a saved annotation, or the phone's predicted corners until one is saved) whose identity has
// not been reviewed yet.
public partial class CardIdentificationViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly CameraAnnotationStore _store;
    private readonly CardCatalogueLookup _catalogue;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly PythonProcessRunner _runner;
    private readonly TrainingPaths _paths;
    private readonly ICameraDatasetChangeTracker _changeTracker;
    private readonly HashSet<string> _skipped = new(StringComparer.OrdinalIgnoreCase);
    private List<IdentityQueueItem> _queue = [];
    private IdentityQueueItem? _current;
    private long _loadGeneration;

    public override string DisplayName => "Card Identification";
    public override string Description => "Confirm or correct which card each camera photo shows.";

    public ObservableCollection<CardChoiceViewModel> Candidates { get; } = [];
    public ObservableCollection<CardChoiceViewModel> SearchResults { get; } = [];

    [ObservableProperty] public partial ImageSource? CardCrop { get; private set; }
    [ObservableProperty] public partial CardChoiceViewModel? Selected { get; private set; }
    [ObservableProperty] public partial string CurrentFileName { get; private set; } = "No photos to identify";
    [ObservableProperty] public partial string CurrentRelativePath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string CaptureDetails { get; private set; } = string.Empty;
    [ObservableProperty] public partial string Status { get; private set; } = "Refresh the queue to begin.";
    [ObservableProperty] public partial string SearchText { get; set; } = string.Empty;
    [ObservableProperty] public partial int QueueCount { get; private set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial bool NewestFirst { get; set; } = true;

    public bool HasPhoto => _current is not null;
    public bool HasSelection => Selected is not null;
    public string QueueSummary => $"Pending  {QueueCount:N0}";

    public CardIdentificationViewModel(
        CameraAnnotationStore store,
        CardCatalogueLookup catalogue,
        WorkspaceOperationCoordinator coordinator,
        PythonProcessRunner runner,
        TrainingPaths paths,
        ICameraDatasetSyncService changeTracker)
    {
        _store = store;
        _catalogue = catalogue;
        _coordinator = coordinator;
        _runner = runner;
        _paths = paths;
        _changeTracker = changeTracker;
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        if (IsBusy) return;
        try
        {
            IsBusy = true;
            Status = "Loading the identification queue…";
            await Task.Yield();
            await ReloadQueueAsync();
        }
        catch (Exception error)
        {
            Status = $"Could not load the identification queue: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    // Runs the current artwork model over annotated photos that have no identity file yet.
    [RelayCommand]
    private async Task SuggestCardsAsync()
    {
        if (IsBusy) return;
        if (!File.Exists(_paths.VirtualEnvironmentPython))
        {
            Status = "The Deckino training runtime is not installed; prepare it on the Runner page first.";
            return;
        }
        try
        {
            IsBusy = true;
            Status = "Guessing cards with the current artwork model…";
            PythonRunResult result;
            var written = new System.Collections.Concurrent.ConcurrentQueue<string>();
            using (await _coordinator.AcquireAsync("suggest card identities", CancellationToken.None))
            {
                result = await _runner.RunAsync(
                    _paths.VirtualEnvironmentPython,
                    ["-m", "deckino_training", "suggest-card-identities", "--training-root", _paths.TrainingRoot],
                    "suggest-card-identities",
                    (_, parsed) =>
                    {
                        if (parsed is not { } line || !line.TryGetProperty("event", out var name)) return;
                        if (name.GetString() == "card_identity_suggested")
                            written.Enqueue(line.GetProperty("path").GetString()!);
                        else if (name.GetString() == "card_identity_suggestions_progress")
                            MainThread.BeginInvokeOnMainThread(() => Status =
                                $"Guessing cards… {line.GetProperty("done").GetInt32():N0} / {line.GetProperty("photos").GetInt32():N0} photos");
                    },
                    CancellationToken.None);
            }
            _changeTracker.TrackUploads(written.ToArray());
            await ReloadQueueAsync();
            Status = result.ExitCode == 0
                ? $"Card guesses are ready. {QueueCount:N0} photos to review."
                : $"Guessing cards failed (exit {result.ExitCode}); see {Path.GetFileName(result.LogPath)}.";
        }
        catch (Exception error)
        {
            Status = $"Guessing cards failed: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private void Select(CardChoiceViewModel choice)
    {
        if (Selected is not null) Selected.IsSelected = false;
        choice.IsSelected = true;
        Selected = choice;
    }

    [RelayCommand]
    private async Task SearchAsync()
    {
        var text = SearchText;
        SearchResults.Clear();
        if (text.Trim().Length < 2) return;
        try
        {
            foreach (var card in await _catalogue.SearchAsync(text))
            {
                if (text != SearchText) return;
                SearchResults.Add(await Task.Run(() => CardChoiceViewModel.Create(card, null)));
            }
            if (SearchResults.Count == 0) Status = $"No card names contain \"{text.Trim()}\".";
        }
        catch (Exception error)
        {
            Status = $"Card search failed: {error.Message}";
        }
    }

    [RelayCommand(CanExecute = nameof(CanConfirm))]
    private Task ConfirmAsync()
    {
        // The model's answer: the phone's lock, or the top guess of "Suggest cards". A phone scan it could not
        // identify had no answer, so any pick there corrects it.
        var identity = _current?.Identity;
        var predicted = identity?.PredictedOracleId
            ?? (identity?.Source == "toolbox" ? identity.Candidates.FirstOrDefault()?.OracleId : null);
        var status = string.Equals(predicted, Selected!.OracleId, StringComparison.OrdinalIgnoreCase)
            ? CardIdentityStatus.Confirmed
            : CardIdentityStatus.Corrected;
        return SaveAsync(status, Selected.OracleId, $"Saved {Selected.Name}.");
    }

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private Task NotACardAsync() => SaveAsync(CardIdentityStatus.NotACard, null, "Marked as not a card.");

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private Task UnreadableAsync() => SaveAsync(CardIdentityStatus.Unreadable, null, "Marked as unreadable.");

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private async Task SkipAsync()
    {
        if (_current is null) return;
        _skipped.Add(_current.Photo.ImagePath);
        Status = "Skipped for this pass.";
        // NextAfter may restart the pass (and say so); the only photo left comes straight back.
        await ShowAsync(NextAfter(_current) ?? _current);
    }

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private Task MoveNextAsync() => MoveAsync(1);

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private Task MovePreviousAsync() => MoveAsync(-1);

    private async Task MoveAsync(int offset)
    {
        if (_current is null) return;
        var index = _queue.IndexOf(_current) + offset;
        if (index >= 0 && index < _queue.Count) await ShowAsync(_queue[index]);
    }

    private async Task SaveAsync(string status, string? oracleId, string message)
    {
        if (_current is not { } item) return;
        try
        {
            IsBusy = true;
            var previous = item.Identity;
            var identity = new CardIdentity
            {
                ImageFile = Path.GetFileName(item.Photo.ImagePath),
                Source = previous?.Source ?? "toolbox",
                CapturedUtc = previous?.CapturedUtc,
                Kind = previous?.Kind,
                ModelVersion = previous?.ModelVersion,
                ExtractorVersion = previous?.ExtractorVersion,
                PredictedCorners = previous?.PredictedCorners,
                Candidates = previous?.Candidates ?? [],
                PredictedOracleId = previous?.PredictedOracleId,
                Status = status,
                OracleId = oracleId,
                ReviewedUtc = DateTimeOffset.UtcNow,
            };
            using (await _coordinator.AcquireAsync("save card identity", CancellationToken.None))
                await Task.Run(() =>
                {
                    _store.SaveIdentity(item.Photo.ImagePath, identity);
                    if (status == CardIdentityStatus.NotACard) SaveNoCardAnnotation(item.Photo);
                });
            var next = NextAfter(item);
            _queue.Remove(item);
            QueueCount = _queue.Count;
            await ShowAsync(next);
            Status = $"{message} {item.FileName}";
        }
        catch (Exception error)
        {
            Status = $"Could not save the card identity: {error.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    // "Not a card" is a corner label too: without it the photo would wait in the Corner Annotator, or keep an
    // annotation that tells extraction training a card is there.
    private void SaveNoCardAnnotation(CameraPhoto photo)
    {
        var existing = File.Exists(photo.AnnotationPath) ? _store.TryLoad(photo.AnnotationPath) : null;
        var annotation = new CardAnnotation
        {
            DatasetVersion = existing?.DatasetVersion ?? "corners-v1",
            ImageFile = Path.GetFileName(photo.ImagePath),
            CardPresent = false,
            ImageWidth = photo.ImageWidth,
            ImageHeight = photo.ImageHeight,
            SourceGroup = existing?.SourceGroup ?? photo.SourceGroup,
            CaptureCondition = existing?.CaptureCondition ?? photo.CaptureCondition,
            Split = existing?.Split,
        };
        if (File.Exists(photo.AnnotationPath)) _store.UpdateExisting(photo.ImagePath, annotation);
        else _store.SaveNew(photo.ImagePath, annotation);
    }

    private async Task ReloadQueueAsync()
    {
        var newestFirst = NewestFirst;
        _queue = await Task.Run(() => _store.ScanPhotos()
            .OrderByQueue(newestFirst)
            .Select(photo =>
            {
                var identity = _store.TryLoadIdentity(photo.ImagePath);
                if (identity is not null && identity.Status != CardIdentityStatus.Unreviewed) return null;
                var annotation = photo.IsAnnotated ? _store.TryLoad(photo.AnnotationPath) : null;
                if (annotation is { CardPresent: false } || photo.HasInvalidAnnotation) return null;
                var (corners, source) = annotation is not null
                    ? (annotation.Points.OfType<NormalizedPoint>().ToArray(), "annotated corners")
                    : (identity?.PredictedCorners, "phone's predicted corners");
                return corners is { Count: 4 } ? new IdentityQueueItem(photo, identity, corners, source) : null;
            })
            .OfType<IdentityQueueItem>()
            .ToList());
        // The order switch may have flipped while the scan ran.
        if (NewestFirst != newestFirst) _queue = _queue.OrderByQueue(item => item.Photo, NewestFirst).ToList();
        QueueCount = _queue.Count;
        await ShowAsync(_queue.FirstOrDefault(item => !_skipped.Contains(item.Photo.ImagePath)) ?? _queue.FirstOrDefault());
        if (_current is null) Status = "No photos are waiting for identification.";
        else if (_current.Identity is null) Status = "This photo has no card guess yet: use Suggest cards, or search below.";
        else Status = $"Ready: {_current.FileName}.";
    }

    private IdentityQueueItem? NextAfter(IdentityQueueItem item)
    {
        var index = _queue.IndexOf(item);
        var others = _queue.Skip(index + 1).Concat(_queue.Take(Math.Max(0, index))).ToList();
        var next = others.FirstOrDefault(other => !_skipped.Contains(other.Photo.ImagePath));
        if (next is not null || others.Count == 0) return next;
        // Everything left was skipped: start another pass over them.
        _skipped.Clear();
        Status = "Reached the end of this pass; returning to skipped photos.";
        return others[0];
    }

    private async Task ShowAsync(IdentityQueueItem? item)
    {
        var generation = Interlocked.Increment(ref _loadGeneration);
        _current = item;
        Selected = null;
        Candidates.Clear();
        SearchResults.Clear();
        SearchText = string.Empty;
        CardCrop = null;
        CurrentFileName = item?.FileName ?? "No photos to identify";
        CurrentRelativePath = item?.Photo.RelativePath ?? string.Empty;
        CaptureDetails = item is null ? string.Empty : Describe(item);
        OnPropertyChanged(nameof(HasPhoto));
        NotifyCommands();
        if (item is null) return;

        var crop = await Task.Run(() =>
        {
            try
            {
                using var stream = File.Open(item.Photo.ImagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var photo = new Bitmap(stream);
                return ImageSourceFactory.FromBitmap(CardGeometryService.CreatePerspectivePreview(photo, item.Corners));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
            {
                // Deleted by a sync, unreadable, or corners too degenerate to rectify; the candidates still show.
                return null;
            }
        });
        if (generation != Interlocked.Read(ref _loadGeneration)) return;
        CardCrop = crop;

        var identity = item.Identity;
        var preferred = identity?.PredictedOracleId ?? identity?.Candidates.FirstOrDefault()?.OracleId;
        foreach (var candidate in identity?.Candidates ?? [])
        {
            var card = await _catalogue.FindAsync(candidate.OracleId, identity!.ModelVersion, candidate.Prototype);
            if (generation != Interlocked.Read(ref _loadGeneration)) return;
            var choice = await Task.Run(() => CardChoiceViewModel.Create(
                card ?? new CatalogueCard(candidate.OracleId, $"Unknown card {candidate.OracleId[..8]}", null),
                candidate.Score));
            Candidates.Add(choice);
            if (Selected is null && string.Equals(choice.OracleId, preferred, StringComparison.OrdinalIgnoreCase)) Select(choice);
        }
        if (Selected is null && Candidates.Count > 0) Select(Candidates[0]);
    }

    private static string Describe(IdentityQueueItem item)
    {
        var identity = item.Identity;
        var parts = new List<string> { item.CornerSource };
        if (identity?.Source == "phone")
        {
            parts.Add(identity.Kind == "locked" ? "phone locked on a card" : "phone could not identify it");
            if (identity.CapturedUtc is { } captured) parts.Add(captured.ToLocalTime().ToString("g"));
        }
        if (identity?.ModelVersion is { } version) parts.Add(version);
        return string.Join("  ·  ", parts);
    }

    private bool CanUsePhoto() => HasPhoto && !IsBusy;
    private bool CanConfirm() => HasPhoto && Selected is not null && !IsBusy;

    private void NotifyCommands()
    {
        ConfirmCommand.NotifyCanExecuteChanged();
        NotACardCommand.NotifyCanExecuteChanged();
        UnreadableCommand.NotifyCanExecuteChanged();
        SkipCommand.NotifyCanExecuteChanged();
        MoveNextCommand.NotifyCanExecuteChanged();
        MovePreviousCommand.NotifyCanExecuteChanged();
    }

    partial void OnSelectedChanged(CardChoiceViewModel? value)
    {
        OnPropertyChanged(nameof(HasSelection));
        ConfirmCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();

    partial void OnQueueCountChanged(int value) => OnPropertyChanged(nameof(QueueSummary));

    // Reorders the loaded queue in memory; nothing on disk changed.
    partial void OnNewestFirstChanged(bool value)
    {
        // Only the order changes; the photo being reviewed stays on screen.
        _queue = _queue.OrderByQueue(item => item.Photo, value).ToList();
    }

    private sealed record IdentityQueueItem(
        CameraPhoto Photo,
        CardIdentity? Identity,
        IReadOnlyList<NormalizedPoint> Corners,
        string CornerSource)
    {
        public string FileName => Path.GetFileName(Photo.ImagePath);
    }
}

public partial class CardChoiceViewModel : ObservableObject
{
    public required string OracleId { get; init; }
    public required string Name { get; init; }
    public ImageSource? Art { get; init; }
    public string ScoreText { get; init; } = string.Empty;

    [ObservableProperty] public partial bool IsSelected { get; set; }

    public static CardChoiceViewModel Create(CatalogueCard card, double? score) => new()
    {
        OracleId = card.OracleId,
        Name = card.Name,
        Art = card.ArtPath is { } path && File.Exists(path) ? ImageSourceFactory.FromFileUnlocked(path) : null,
        ScoreText = score is { } value ? $"score {value:0.00}" : string.Empty,
    };
}
