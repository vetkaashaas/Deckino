using System.Collections.ObjectModel;
using System.Drawing;
using System.IO;
using System.Text.Json.Serialization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Bridge;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

// Labels which card a camera photo shows, writing <photo>._identity.json. The queue is every photo with a card
// in known corners (a saved annotation, or the phone's predicted corners until one is saved) whose identity has
// not been reviewed yet. Without a saved annotation the card is cut out with the latest extractor and refiner, so
// the page shows the best crop the Toolbox can make whatever the phone captured.
public partial class CardIdentificationViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly CameraAnnotationStore _store;
    private readonly CardCatalogueLookup _catalogue;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly CardIdentitySuggestionService _suggestions;
    private readonly IExtractionCornerSuggestionService _corners;
    private readonly HashSet<string> _skipped = new(StringComparer.OrdinalIgnoreCase);
    private List<IdentityQueueItem> _queue = [];
    private IdentityQueueItem? _current;
    // The corners the current photo is shown and guessed with; see CornersForAsync.
    private Task<CardCorners> _currentCorners = Task.FromResult(new CardCorners([], string.Empty));
    private readonly SemaphoreSlim _cornerGate = new(1, 1);
    // The current model's guesses for the photo on screen, from "Suggest cards"; saved with the review only.
    private CardIdentitySuggestion? _suggestion;
    private long _loadGeneration;
    // Bumped by every change of the candidate list (a new photo or "Suggest cards"); _loadGeneration only by photos.
    private long _candidateGeneration;
    private List<PrintingChoiceViewModel> _allPrintings = [];

    public override string DisplayName => "Identify Card";
    public override string Description => "Confirm or correct which card each camera photo shows.";

    public ObservableCollection<CardChoiceViewModel> Candidates { get; } = [];
    public ObservableCollection<CardChoiceViewModel> SearchResults { get; } = [];
    public ObservableCollection<PrintingChoiceViewModel> Printings { get; } = [];

    [ObservableProperty] public partial string? CardCropUrl { get; private set; }
    [ObservableProperty] public partial CardChoiceViewModel? Selected { get; private set; }
    [ObservableProperty] public partial PrintingChoiceViewModel? SelectedPrinting { get; set; }
    [ObservableProperty] public partial string PrintingFilter { get; set; } = string.Empty;
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
    public bool HasPrintingChoice => _allPrintings.Count > 1;
    // The chosen printing's art, or the card's while that printing's image isn't downloaded: one file looked at.
    public string? SavedArtUrl => SelectedPrinting is { ArtPath: { } path } printing && File.Exists(path)
        ? printing.ArtUrl
        : Selected?.ArtUrl;
    public string SavedPrintingText => SelectedPrinting?.Label
        ?? (HasPrintingChoice ? $"Pick the printing in the photo · {_allPrintings.Count:N0} printings" : string.Empty);
    public string QueueSummary => $"Pending  {QueueCount:N0}";

    public CardIdentificationViewModel(
        CameraAnnotationStore store,
        CardCatalogueLookup catalogue,
        WorkspaceOperationCoordinator coordinator,
        CardIdentitySuggestionService suggestions,
        IExtractionCornerSuggestionService corners)
    {
        _store = store;
        _catalogue = catalogue;
        _coordinator = coordinator;
        _suggestions = suggestions;
        _corners = corners;
    }

    public Task LeaveAsync() => _suggestions.StopAsync();

    [RelayCommand]
    public async Task RefreshAsync()
    {
        if (IsBusy) return;
        _ = _suggestions.WarmUpAsync();
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

    // Shows the current artwork model's guesses for this photo in place of the phone's. Nothing is written until
    // the photo is saved, and then the phone's guesses are kept next to these.
    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private async Task SuggestCardsAsync()
    {
        if (_current is not { } item) return;
        try
        {
            IsBusy = true;
            Status = "Guessing this card with the current artwork model…";
            var corners = await _currentCorners;
            var suggestion = await _suggestions.SuggestAsync(item.Photo.ImagePath, corners.Points);
            if (_current != item) return;
            _suggestion = suggestion;
            var generation = Interlocked.Increment(ref _candidateGeneration);
            Selected = null;
            Candidates.Clear();
            CaptureDetails = Describe(item, corners, suggestion);
            await ShowCandidatesAsync(generation, suggestion.Candidates, suggestion.ModelVersion, null);
            Status = suggestion.Candidates.Count == 0
                ? $"{suggestion.ModelVersion} found no likely card; search below."
                : $"Showing {suggestion.ModelVersion}'s guesses. Saving keeps the phone's guesses too.";
        }
        catch (Exception error)
        {
            Status = $"Could not suggest cards: {error.Message}";
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
            var cards = await _catalogue.SearchAsync(text);
            if (text != SearchText) return;
            foreach (var card in cards) SearchResults.Add(CardChoiceViewModel.Create(card, null));
            if (SearchResults.Count == 0) Status = $"No card names contain \"{text.Trim()}\".";
        }
        catch (Exception error)
        {
            Status = $"Card search failed: {error.Message}";
        }
    }

    [RelayCommand(CanExecute = nameof(CanConfirm))]
    private async Task ConfirmAsync()
    {
        // Everything this photo's label needs, taken now: the lookups below can take seconds on first use.
        var item = _current!;
        var suggestion = _suggestion;
        var card = Selected!;
        var printing = SelectedPrinting!;
        // Judged against the photo's first answer: the phone's lock, an older toolbox guess, or (for a photo with
        // no earlier guess) the top guess of "Suggest cards". A phone scan it could not identify had no answer, so
        // any pick there corrects it.
        var identity = item.Identity;
        var (predicted, modelVersion, candidates) = identity is { Source: "phone" or "shared" } || identity?.Candidates.Count > 0
            ? (identity.PredictedOracleId
                ?? (identity.Source == "toolbox" ? identity.Candidates.FirstOrDefault()?.OracleId : null),
                identity.ModelVersion, identity.Candidates)
            : (suggestion?.Candidates.FirstOrDefault()?.OracleId, suggestion?.ModelVersion, suggestion?.Candidates ?? []);
        var right = string.Equals(predicted, card.OracleId, StringComparison.OrdinalIgnoreCase);
        try
        {
            IsBusy = true;
            // The right card with another printing's art is still a miss for an artwork model. When the guessing
            // model's labels are not on this computer its printing is unknown, and only the card is judged.
            var guessed = candidates.FirstOrDefault(candidate =>
                string.Equals(candidate.OracleId, predicted, StringComparison.OrdinalIgnoreCase));
            if (right && await _catalogue.PrintingForPrototypeAsync(modelVersion, guessed?.Prototype) is { } guessedPrinting)
                right = await _catalogue.SameArtworkAsync(guessedPrinting, printing.PrintingId);
        }
        catch (Exception error)
        {
            Status = $"Could not save the card identity: {error.Message}";
            IsBusy = false;
            return;
        }
        await SaveAsync(item, suggestion, right ? CardIdentityStatus.Confirmed : CardIdentityStatus.Corrected,
            card.OracleId, printing.PrintingId, $"Saved {card.Name} ({printing.Label}).");
    }

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private Task NotACardAsync() => SaveAsync(_current!, _suggestion, CardIdentityStatus.NotACard, null, null, "Marked as not a card.");

    [RelayCommand(CanExecute = nameof(CanUsePhoto))]
    private Task UnreadableAsync() => SaveAsync(_current!, _suggestion, CardIdentityStatus.Unreadable, null, null, "Marked as unreadable.");

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

    private async Task SaveAsync(IdentityQueueItem item, CardIdentitySuggestion? suggestion, string status,
        string? oracleId, string? printingId, string message)
    {
        try
        {
            IsBusy = true;
            var previous = item.Identity;
            var identity = new CardIdentity
            {
                ImageFile = Path.GetFileName(item.Photo.ImagePath),
                Source = previous?.Source ?? "toolbox",
                CapturedUtc = previous?.CapturedUtc,
                UserId = previous?.UserId,
                Kind = previous?.Kind,
                ModelVersion = previous?.ModelVersion,
                ExtractorVersion = previous?.ExtractorVersion,
                PredictedCorners = previous?.PredictedCorners,
                Candidates = previous?.Candidates ?? [],
                PredictedOracleId = previous?.PredictedOracleId,
                ToolboxModelVersion = suggestion?.ModelVersion ?? previous?.ToolboxModelVersion,
                ToolboxCandidates = suggestion?.Candidates ?? previous?.ToolboxCandidates,
                Status = status,
                OracleId = oracleId,
                PrintingId = printingId,
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
                    : (identity?.PredictedCorners, PhoneCorners);
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
        var candidateGeneration = Interlocked.Increment(ref _candidateGeneration);
        _current = item;
        _suggestion = null;
        Selected = null;
        Candidates.Clear();
        SearchResults.Clear();
        SearchText = string.Empty;
        CardCropUrl = null;
        CurrentFileName = item?.FileName ?? "No photos to identify";
        CurrentRelativePath = item?.Photo.RelativePath ?? string.Empty;
        CaptureDetails = string.Empty;
        OnPropertyChanged(nameof(HasPhoto));
        NotifyCommands();
        if (item is null) return;

        // The phone's guesses do not depend on the corners, so they show while the model finds the card.
        var identity = item.Identity;
        var candidates = ShowCandidatesAsync(
            candidateGeneration, identity?.Candidates ?? [], identity?.ModelVersion, identity?.PredictedOracleId);
        try
        {
            var cornersTask = _currentCorners = CornersForAsync(item);
            // The corners the photo came with show at once; the model's (its worker takes seconds to start) replace
            // them when they come.
            var known = new CardCorners(item.Corners, item.CornerSource);
            var crop = await CropAsync(item, known);
            if (generation != Interlocked.Read(ref _loadGeneration)) return;
            CaptureDetails = Describe(item, known, null);
            CardCropUrl = crop;
            var corners = await cornersTask;
            if (generation != Interlocked.Read(ref _loadGeneration) || corners.Points == item.Corners) return;
            CaptureDetails = Describe(item, corners, null);
            crop = await CropAsync(item, corners);
            if (generation != Interlocked.Read(ref _loadGeneration)) return;
            CardCropUrl = crop;
        }
        finally
        {
            await candidates;
        }
    }

    private static Task<string?> CropAsync(IdentityQueueItem item, CardCorners corners) =>
        Task.Run(() =>
        {
            try
            {
                using var stream = File.Open(item.Photo.ImagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var photo = new Bitmap(stream);
                return Images.FromBitmap(CardGeometryService.CreatePerspectivePreview(photo, corners.Points));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
            {
                // Deleted by a sync, unreadable, or corners too degenerate to rectify; the candidates still show.
                return (string?)null;
            }
        });

    private async Task ShowCandidatesAsync(
        long generation, IReadOnlyList<IdentityCandidate> candidates, string? modelVersion, string? preferred)
    {
        preferred ??= candidates.FirstOrDefault()?.OracleId;
        foreach (var candidate in candidates)
        {
            var card = await _catalogue.FindAsync(candidate.OracleId, modelVersion, candidate.Prototype);
            if (generation != Interlocked.Read(ref _candidateGeneration)) return;
            var choice = CardChoiceViewModel.Create(
                card ?? new CatalogueCard(candidate.OracleId, $"Unknown card {candidate.OracleId[..8]}", null, null),
                candidate.Score);
            Candidates.Add(choice);
            if (Selected is null && string.Equals(choice.OracleId, preferred, StringComparison.OrdinalIgnoreCase)) Select(choice);
        }
        if (Selected is null && Candidates.Count > 0) Select(Candidates[0]);
    }

    // Lists the selected card's printings and preselects the one the model matched, or the only one there is.
    private async Task LoadPrintingsAsync(CardChoiceViewModel? card)
    {
        _allPrintings = [];
        Printings.Clear();
        PrintingFilter = string.Empty;
        SelectedPrinting = null;
        OnPropertyChanged(nameof(HasPrintingChoice));
        if (card is null) return;
        IReadOnlyList<CataloguePrinting> printings;
        try
        {
            printings = await _catalogue.PrintingsAsync(card.OracleId);
        }
        catch (Exception error)
        {
            Status = $"Could not list the printings of {card.Name}: {error.Message}";
            return;
        }
        if (Selected != card) return;
        _allPrintings = printings.Select(PrintingChoiceViewModel.Create).ToList();
        if (_allPrintings.Count == 0)
            Status = $"{card.Name} has no paper printing in the catalogue, so a photo cannot show it; pick another card.";
        foreach (var printing in _allPrintings) Printings.Add(printing);
        SelectedPrinting = _allPrintings.Count == 1
            ? _allPrintings[0]
            : _allPrintings.FirstOrDefault(printing =>
                string.Equals(printing.PrintingId, card.PrintingId, StringComparison.OrdinalIgnoreCase));
        OnPropertyChanged(nameof(HasPrintingChoice));
        OnPropertyChanged(nameof(SavedPrintingText));
        ConfirmCommand.NotifyCanExecuteChanged();
    }

    partial void OnPrintingFilterChanged(string value)
    {
        var text = value.Trim();
        Printings.Clear();
        foreach (var printing in _allPrintings.Where(printing => printing.Matches(text))) Printings.Add(printing);
    }

    partial void OnSelectedPrintingChanged(PrintingChoiceViewModel? value)
    {
        OnPropertyChanged(nameof(SavedArtUrl));
        OnPropertyChanged(nameof(SavedPrintingText));
        ConfirmCommand.NotifyCanExecuteChanged();
    }

    // Hand-annotated corners are kept as they are. Otherwise the latest extractor and refiner find the card in the
    // photo; the phone's own corners are the fallback when that model is missing or fails.
    private async Task<CardCorners> CornersForAsync(IdentityQueueItem item)
    {
        if (item.CornerSource != PhoneCorners) return new(item.Corners, item.CornerSource);
        // One request at a time from this page, and none for a photo already left behind: browsing quickly would
        // otherwise queue a model run per photo passed over in front of the one on screen.
        await _cornerGate.WaitAsync();
        try
        {
            if (_current != item) return new(item.Corners, item.CornerSource);
            // Never cancelled: a cancelled request restarts the worker, and browsing quickly would do that per photo.
            var suggestion = await _corners.SuggestAsync(item.Photo.ImagePath, CancellationToken.None);
            if (suggestion.Corners is { Count: 4 } points) return new(points, $"{suggestion.ModelVersion} corners");
            if (_current == item) Status = $"{suggestion.ModelVersion} found no card here; showing the phone's corners.";
        }
        catch (Exception error)
        {
            if (_current == item) Status = $"Showing the phone's corners; the extraction model could not run: {error.Message}";
        }
        finally
        {
            _cornerGate.Release();
        }
        return new(item.Corners, item.CornerSource);
    }

    private static string Describe(IdentityQueueItem item, CardCorners corners, CardIdentitySuggestion? suggestion)
    {
        var identity = item.Identity;
        var parts = new List<string> { corners.Source };
        if (identity?.Source is "phone" or "shared")
        {
            var from = identity.Source == "shared" ? "shared photo" : "phone";
            parts.Add(identity.Kind == "locked" ? $"{from} locked on a card" : $"{from} could not identify it");
            if (identity.CapturedUtc is { } captured) parts.Add(captured.ToLocalTime().ToString("g"));
        }
        if (identity?.ModelVersion is { } version) parts.Add(suggestion is null ? version : $"first guessed by {version}");
        if (suggestion is not null) parts.Add($"showing {suggestion.ModelVersion}");
        return string.Join("  ·  ", parts);
    }

    private bool CanUsePhoto() => HasPhoto && !IsBusy;
    // Every label names the exact printing: training learns artworks, and skips labels without one.
    private bool CanConfirm() => HasPhoto && Selected is not null && SelectedPrinting is not null && !IsBusy;

    private void NotifyCommands()
    {
        ConfirmCommand.NotifyCanExecuteChanged();
        SuggestCardsCommand.NotifyCanExecuteChanged();
        NotACardCommand.NotifyCanExecuteChanged();
        UnreadableCommand.NotifyCanExecuteChanged();
        SkipCommand.NotifyCanExecuteChanged();
        MoveNextCommand.NotifyCanExecuteChanged();
        MovePreviousCommand.NotifyCanExecuteChanged();
    }

    partial void OnSelectedChanged(CardChoiceViewModel? value)
    {
        OnPropertyChanged(nameof(HasSelection));
        OnPropertyChanged(nameof(SavedArtUrl));
        ConfirmCommand.NotifyCanExecuteChanged();
        _ = LoadPrintingsAsync(value);
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();

    partial void OnQueueCountChanged(int value) => OnPropertyChanged(nameof(QueueSummary));

    // Reorders the loaded queue in memory; nothing on disk changed.
    partial void OnNewestFirstChanged(bool value)
    {
        // Only the order changes; the photo being reviewed stays on screen.
        _queue = _queue.OrderByQueue(item => item.Photo, value).ToList();
    }

    private const string PhoneCorners = "phone's predicted corners";

    private sealed record CardCorners(IReadOnlyList<NormalizedPoint> Points, string Source);

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
    public string? ArtUrl { get; init; }
    public string ScoreText { get; init; } = string.Empty;
    // The printing the model matched, preselected among the card's printings.
    public string? PrintingId { get; init; }

    [ObservableProperty] public partial bool IsSelected { get; set; }

    public static CardChoiceViewModel Create(CatalogueCard card, double? score) => new()
    {
        OracleId = card.OracleId,
        Name = card.Name,
        PrintingId = card.PrintingId,
        ArtUrl = Images.CardArt(card.ArtPath),
        ScoreText = score is { } value ? $"score {value:0.00}" : string.Empty,
    };
}

public sealed class PrintingChoiceViewModel
{
    public required string PrintingId { get; init; }
    public required string Label { get; init; }
    public string? SetName { get; init; }
    [JsonIgnore] public string? ArtPath { get; init; }
    public string? ArtUrl { get; init; }

    public bool Matches(string text) => text.Length == 0
        || Label.Contains(text, StringComparison.OrdinalIgnoreCase)
        || SetName?.Contains(text, StringComparison.OrdinalIgnoreCase) == true;

    public static PrintingChoiceViewModel Create(CataloguePrinting printing) => new()
    {
        PrintingId = printing.PrintingId,
        Label = $"{printing.SetCode.ToUpperInvariant()} #{printing.CollectorNumber}",
        SetName = printing.SetName,
        ArtPath = printing.ArtPath,
        ArtUrl = Images.CardArt(printing.ArtPath),
    };
}
