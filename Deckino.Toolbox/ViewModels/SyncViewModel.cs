using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Dapper;
using Deckino.Toolbox.Controls;
using Deckino.Toolbox.Data;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

/// <summary>One step of a Scryfall sync: its state, a one-line result, its own progress and how long it took.</summary>
public sealed partial class SyncStageViewModel(string name) : ObservableObject
{
    private readonly Stopwatch _clock = new();

    public string Name { get; } = name;

    [ObservableProperty] public partial ProductionStageStatus Status { get; private set; } = ProductionStageStatus.Pending;
    [ObservableProperty] public partial string Detail { get; set; } = "Waiting";
    [ObservableProperty] public partial string Duration { get; private set; } = string.Empty;

    // Below zero while the stage runs without a measurable total; the bar is hidden then.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowsProgress))]
    public partial double ProgressPercent { get; set; } = -1;

    public bool ShowsProgress => Status == ProductionStageStatus.Running && ProgressPercent >= 0;

    partial void OnStatusChanged(ProductionStageStatus value) => OnPropertyChanged(nameof(ShowsProgress));

    public void Reset()
    {
        _clock.Reset();
        Status = ProductionStageStatus.Pending;
        Detail = "Waiting";
        Duration = string.Empty;
        ProgressPercent = -1;
    }

    // A stage can run more than once in a sync (two bulk files are downloaded and imported in turn), so its clock
    // keeps adding up until the next Reset.
    public void Start(string detail)
    {
        if (Status == ProductionStageStatus.Running) return;
        _clock.Start();
        Status = ProductionStageStatus.Running;
        Detail = detail;
        ProgressPercent = -1;
    }

    public void Finish(ProductionStageStatus status, string detail)
    {
        _clock.Stop();
        Status = status;
        Detail = detail;
        Duration = _clock.Elapsed > TimeSpan.Zero ? SyncViewModel.FormatDuration(_clock.Elapsed) : string.Empty;
    }
}

public partial class SyncViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private const int MaximumLogLines = 400;
    // Failures logged by name per run; a lost connection fails thousands, which the run summary counts instead.
    private const int LoggedFailures = 100;

    private readonly Database _database;
    private readonly BulkDataSyncService _bulkSync;
    private readonly CardImageService _cardImages;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly ApplicationLogService _applicationLog;
    private readonly IDesktopService _desktop;
    private CancellationTokenSource? _activeRun;
    private bool _checkedFreshness;

    public SyncViewModel(
        Database database,
        BulkDataSyncService bulkSync,
        CardImageService cardImages,
        WorkspaceOperationCoordinator coordinator,
        ApplicationLogService applicationLog,
        IDesktopService desktop)
    {
        _database = database;
        _bulkSync = bulkSync;
        _cardImages = cardImages;
        _coordinator = coordinator;
        _applicationLog = applicationLog;
        _desktop = desktop;
        Stages = [CheckStage, DownloadStage, ImportStage, ReconcileStage, ImagesStage];
    }

    public override string DisplayName => "Scryfall Sync";
    public override string Description =>
        "Keeps the local Scryfall catalogue current and caches the full-card image of every paper face.";

    public SyncStageViewModel CheckStage { get; } = new("Check Scryfall");
    public SyncStageViewModel DownloadStage { get; } = new("Download bulk files");
    public SyncStageViewModel ImportStage { get; } = new("Import catalogue");
    public SyncStageViewModel ReconcileStage { get; } = new("Prepare image cache");
    public SyncStageViewModel ImagesStage { get; } = new("Download card images");
    public IReadOnlyList<SyncStageViewModel> Stages { get; }

    public ObservableCollection<string> LiveLog { get; } = [];

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SyncCommand), nameof(CheckForUpdatesCommand), nameof(RetryFailedCommand),
        nameof(CancelCommand))]
    [NotifyPropertyChangedFor(nameof(IsIdle))]
    public partial bool IsBusy { get; private set; }

    public bool IsIdle => !IsBusy;

    [ObservableProperty] public partial string FreshnessText { get; private set; } = "Not checked";
    [ObservableProperty] public partial StatusTone FreshnessTone { get; private set; } = StatusTone.Neutral;
    [ObservableProperty] public partial string Status { get; private set; } = "Ready.";
    [ObservableProperty] public partial string LastRunText { get; private set; } = "No sync has run on this computer yet.";
    [ObservableProperty] public partial string ErrorMessage { get; private set; } = string.Empty;
    [ObservableProperty] public partial string? SelectedLogLine { get; set; }

    [ObservableProperty] public partial string Printings { get; private set; } = "—";
    [ObservableProperty] public partial string OracleCards { get; private set; } = "—";
    [ObservableProperty] public partial string Sets { get; private set; } = "—";
    [ObservableProperty] public partial string ImagesCached { get; private set; } = "—";
    [ObservableProperty] public partial string ImagesCaption { get; private set; } = string.Empty;
    [ObservableProperty] public partial double ImagesPercent { get; private set; }
    [ObservableProperty] public partial string ImagesFailed { get; private set; } = "—";
    [ObservableProperty] public partial string DiskUsed { get; private set; } = "—";
    // Shows Retry failed in the header while failed faces wait for another attempt.
    [ObservableProperty] public partial bool HasFailures { get; private set; }

    private string? _errorDetail;
    private long _failuresLogged;

    public async Task RefreshAsync()
    {
        await RefreshCountsAsync();
        await RefreshLastRunAsync();
        if (_checkedFreshness || IsBusy) return;
        _checkedFreshness = true;
        try
        {
            await CheckFreshnessAsync(CancellationToken.None);
        }
        catch (Exception error)
        {
            // Offline or an unreadable reply: the local sync date still shows; Check for updates retries.
            _applicationLog.Information("scryfall-sync", $"Automatic freshness check failed: {error.Message}");
        }
    }

    private bool CanRun => !IsBusy;

    [RelayCommand(CanExecute = nameof(CanRun))]
    private Task SyncAsync() => RunAsync("Scryfall sync", includeCatalogue: true, retryFailed: false);

    [RelayCommand(CanExecute = nameof(CanRun))]
    private Task RetryFailedAsync() => RunAsync("Image retry", includeCatalogue: false, retryFailed: true);

    [RelayCommand(CanExecute = nameof(CanRun))]
    private async Task CheckForUpdatesAsync()
    {
        IsBusy = true;
        ErrorMessage = string.Empty;
        Status = "Asking Scryfall for its latest bulk files…";
        try
        {
            await CheckFreshnessAsync(CancellationToken.None);
            Status = FreshnessText;
            AppendLog($"Checked Scryfall: {FreshnessText}.");
        }
        catch (Exception error)
        {
            ShowError("Could not reach Scryfall", error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(IsBusy))]
    private void Cancel()
    {
        _activeRun?.Cancel();
        Status = "Cancelling…";
    }

    [RelayCommand]
    private void OpenImageFolder()
    {
        Directory.CreateDirectory(_cardImages.ImagesDirectory);
        _desktop.OpenFolder(_cardImages.ImagesDirectory);
    }

    [RelayCommand]
    private void OpenLogFolder()
    {
        Directory.CreateDirectory(_applicationLog.LogsRoot);
        _desktop.OpenFolder(_applicationLog.LogsRoot);
    }

    [RelayCommand]
    private void ClearLog()
    {
        LiveLog.Clear();
        SelectedLogLine = null;
    }

    [RelayCommand]
    private async Task CopySelectedLogAsync()
    {
        if (!string.IsNullOrWhiteSpace(SelectedLogLine)) await _desktop.CopyTextAsync(SelectedLogLine);
    }

    [RelayCommand]
    private async Task CopyAllLogsAsync()
    {
        if (LiveLog.Count > 0) await _desktop.CopyTextAsync(string.Join(Environment.NewLine, LiveLog));
    }

    [RelayCommand]
    private async Task CopyErrorAsync()
    {
        if (!string.IsNullOrWhiteSpace(_errorDetail)) await _desktop.CopyTextAsync(_errorDetail);
    }

    [RelayCommand]
    private void DismissError() => ErrorMessage = string.Empty;

    private async Task RunAsync(string operation, bool includeCatalogue, bool retryFailed)
    {
        using var run = new CancellationTokenSource();
        _activeRun = run;
        IsBusy = true;
        ErrorMessage = string.Empty;
        foreach (var stage in Stages) stage.Reset();
        var started = DateTime.UtcNow;
        var summary = new List<string>();
        var outcome = "passed";
        AppendLog($"{operation} started.");
        try
        {
            using var lease = await _coordinator.AcquireAsync(operation, run.Token);
            if (includeCatalogue)
            {
                summary.Add(await RunCatalogueAsync(run.Token));
            }
            else
            {
                foreach (var stage in new[] { CheckStage, DownloadStage, ImportStage })
                    stage.Finish(ProductionStageStatus.Cancelled, "Not part of an image retry");
            }
            summary.Add(await RunImagesAsync(retryFailed, run.Token));
            Status = string.Join(" ", summary);
        }
        catch (OperationCanceledException) when (run.IsCancellationRequested)
        {
            outcome = "cancelled";
            CancelRunningStages();
            Status = "Cancelled. Everything finished so far is kept; the next sync picks up where this one stopped.";
            summary.Add("Cancelled.");
        }
        catch (Exception error)
        {
            outcome = "failed";
            var running = Stages.FirstOrDefault(stage => stage.Status == ProductionStageStatus.Running);
            running?.Finish(ProductionStageStatus.Failed, error.Message);
            CancelRunningStages();
            ShowError($"{running?.Name ?? operation} failed", error);
            summary.Add($"Failed: {error.Message}");
        }
        finally
        {
            _activeRun = null;
            IsBusy = false;
            AppendLog($"{operation} {outcome} after {FormatDuration(DateTime.UtcNow - started)}.");
            try
            {
                await RefreshCountsAsync();
                await RecordRunAsync(started, outcome, string.Join(" ", summary));
            }
            catch (Exception error)
            {
                // The run itself is over; only its record or the refreshed counts are missing.
                ShowError("Could not record the sync run", error);
            }
        }
    }

    private async Task<string> RunCatalogueAsync(CancellationToken cancellationToken)
    {
        var before = await CountCatalogueAsync();
        CheckStage.Start("Asking Scryfall for its latest bulk files…");
        var progress = new Progress<BulkSyncStatus>(status =>
        {
            switch (status.Phase)
            {
                case BulkSyncPhase.Checking:
                    CheckStage.Start("Asking Scryfall for its latest bulk files…");
                    break;
                case BulkSyncPhase.Downloading:
                    if (CheckStage.Status == ProductionStageStatus.Running)
                        CheckStage.Finish(ProductionStageStatus.Passed, "Newer data published");
                    if (ImportStage.Status == ProductionStageStatus.Running)
                        ImportStage.Finish(ProductionStageStatus.Passed, "Oracle cards imported");
                    DownloadStage.Start($"{Capitalize(status.Stage)}…");
                    DownloadStage.Detail = status.Total is { } total
                        ? $"{Capitalize(status.Stage)} · {status.Processed:N0} / {total:N0} MB"
                        : $"{Capitalize(status.Stage)} · {status.Processed:N0} MB";
                    DownloadStage.ProgressPercent = status.Total is { } size and > 0 ? status.Processed * 100.0 / size : -1;
                    break;
                default:
                    if (DownloadStage.Status == ProductionStageStatus.Running)
                        DownloadStage.Finish(ProductionStageStatus.Passed, "Download complete");
                    ImportStage.Start(status.Stage);
                    ImportStage.Detail = $"{Capitalize(status.Stage)} · {status.Processed:N0} rows";
                    break;
            }
            Status = $"{Capitalize(status.Stage)}…";
        });
        var result = await _bulkSync.SyncAllAsync(progress, cancellationToken);
        var after = await CountCatalogueAsync();

        if (CheckStage.Status == ProductionStageStatus.Running)
            CheckStage.Finish(ProductionStageStatus.Passed, "Already up to date");
        var everythingCurrent = result.CardsImported == 0 && result.OracleCardsImported == 0;
        DownloadStage.Finish(ProductionStageStatus.Passed, everythingCurrent
            ? "Skipped, nothing new on Scryfall"
            : $"Downloaded {Plural(2 - result.SkippedUpToDate.Count, "bulk file")}");
        var changes = $"{Signed(after.Printings - before.Printings)} printings, "
            + $"{Signed(after.Oracles - before.Oracles)} oracle cards, {Signed(after.Sets - before.Sets)} sets";
        ImportStage.Finish(ProductionStageStatus.Passed, everythingCurrent
            ? "Skipped, the catalogue is current"
            : $"{changes} ({result.CardsImported:N0} printings and {result.OracleCardsImported:N0} oracle cards read)");
        FreshnessText = $"Up to date · synced {DescribeAge(DateTime.UtcNow)}";
        FreshnessTone = StatusTone.Success;
        _checkedFreshness = true;
        AppendLog(everythingCurrent ? "Catalogue already up to date." : $"Catalogue imported: {changes}.");
        await RefreshCountsAsync();
        return everythingCurrent ? "Catalogue up to date." : $"Catalogue: {changes}.";
    }

    private async Task<string> RunImagesAsync(bool retryFailed, CancellationToken cancellationToken)
    {
        ReconcileStage.Start("Checking cached images against the catalogue…");
        var reconcile = new Progress<CardImageReconcileStatus>(status =>
        {
            ReconcileStage.Detail = $"Checked {status.Scanned:N0} / {status.Total:N0} queued files on disk · "
                + $"{status.Recovered:N0} already present";
            ReconcileStage.ProgressPercent = status.Total == 0 ? -1 : status.Scanned * 100.0 / status.Total;
        });
        var preparation = await _cardImages.PrepareAsync(retryFailed, reconcile, cancellationToken);
        var notes = new List<string>();
        if (preparation.FilesRemoved > 0)
        {
            notes.Add($"removed {preparation.FilesRemoved:N0} unused files ({FormatBytes(preparation.BytesRemoved)})");
            AppendLog($"Removed {preparation.FilesRemoved:N0} unused files (old art crops, replaced or dropped card "
                + $"images): {FormatBytes(preparation.BytesRemoved)}.");
        }
        if (preparation.Recovered > 0) notes.Add($"found {preparation.Recovered:N0} already on disk");
        if (preparation.Requeued > 0)
            notes.Add($"re-queued {preparation.Requeued:N0} {(retryFailed ? "failed or missing" : "missing")}");
        ReconcileStage.Finish(ProductionStageStatus.Passed,
            notes.Count == 0 ? "Cache matches the catalogue" : Capitalize(string.Join(" · ", notes)));
        await RefreshCountsAsync();

        var cache = await _cardImages.InspectAsync(cancellationToken);
        if (cache.Pending == 0)
        {
            if (cache.Failed > 0)
            {
                var failed = $"{cache.Downloaded:N0} card images cached, {cache.Failed:N0} failed earlier "
                    + "(Retry failed asks again)";
                ImagesStage.Finish(ProductionStageStatus.Warning, failed);
                return failed + ".";
            }
            ImagesStage.Finish(ProductionStageStatus.Passed, $"All {cache.Downloaded:N0} card images cached");
            return "Card images complete.";
        }
        ImagesStage.Start($"{cache.Pending:N0} images queued");
        var clock = Stopwatch.StartNew();
        var queued = cache.Pending;
        _failuresLogged = 0;
        var progress = new Progress<CardImageProgress>(status => ShowDownload(status, queued, clock.Elapsed, cache));
        var result = await _cardImages.DownloadPendingAsync(null, progress, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var detail = $"Downloaded {result.Downloaded:N0} images"
            + (result.Failed > 0 ? $", {result.Failed:N0} failed" : string.Empty)
            + $" · {Rate(result.Downloaded + result.Failed, clock.Elapsed)}";
        ImagesStage.Finish(result.Failed > 0 ? ProductionStageStatus.Warning : ProductionStageStatus.Passed, detail);
        if (result.Failed > _failuresLogged)
            AppendLog($"{result.Failed - _failuresLogged:N0} more images failed; Retry failed asks Scryfall again.");
        AppendLog(detail + ".");
        return detail + ".";
    }

    private void ShowDownload(CardImageProgress status, long queued, TimeSpan elapsed, CardImageCacheStatus start)
    {
        var finished = status.Downloaded + status.Failed;
        var perSecond = elapsed.TotalSeconds > 1 ? finished / elapsed.TotalSeconds : 0;
        var eta = perSecond > 0 ? FormatDuration(TimeSpan.FromSeconds(status.Remaining / perSecond)) : "estimating";
        ImagesStage.Detail = $"{finished:N0} / {queued:N0} · {status.Failed:N0} failed · {perSecond:0.0} images/s · {eta} left";
        ImagesStage.ProgressPercent = queued == 0 ? 0 : finished * 100.0 / queued;
        ImagesCached = (start.Downloaded + status.Downloaded).ToString("N0", CultureInfo.CurrentCulture);
        ImagesPercent = start.Total == 0 ? 0 : (start.Downloaded + status.Downloaded) * 100.0 / start.Total;
        ImagesCaption = $"of {start.Total:N0} faces · {ImagesPercent:0.0}%";
        ImagesFailed = (start.Failed + status.Failed).ToString("N0", CultureInfo.CurrentCulture);
        foreach (var failure in status.Failures)
        {
            if (_failuresLogged >= LoggedFailures) break;
            _failuresLogged++;
            var face = failure.FaceIndex > 0 ? $" · face {failure.FaceIndex + 1}" : string.Empty;
            AppendLog($"Failed {failure.Name} · {failure.SetCode.ToUpperInvariant()} #{failure.CollectorNumber}{face}: "
                + failure.Error);
        }
    }

    private void CancelRunningStages()
    {
        foreach (var stage in Stages.Where(stage => stage.Status is ProductionStageStatus.Running or ProductionStageStatus.Pending))
            stage.Finish(ProductionStageStatus.Cancelled, stage.Status == ProductionStageStatus.Running ? "Stopped" : "Not run");
    }

    private async Task CheckFreshnessAsync(CancellationToken cancellationToken)
    {
        var files = await _bulkSync.CheckFreshnessAsync(cancellationToken);
        var lastSync = files.Select(file => ParseUtc(file.SyncedAt)).Where(value => value is not null).Max();
        if (files.Count == 0 || files.Any(file => file.LocalUpdatedAt is null))
        {
            FreshnessText = "Never synced";
            FreshnessTone = StatusTone.Warning;
        }
        else if (files.All(file => file.UpToDate))
        {
            FreshnessText = $"Up to date · synced {DescribeAge(lastSync)}";
            FreshnessTone = StatusTone.Success;
        }
        else
        {
            FreshnessText = $"Scryfall has newer data · synced {DescribeAge(lastSync)}";
            FreshnessTone = StatusTone.Warning;
        }
    }

    private async Task RefreshCountsAsync()
    {
        var catalogue = await CountCatalogueAsync();
        var cache = await _cardImages.InspectAsync();
        Printings = catalogue.Printings.ToString("N0", CultureInfo.CurrentCulture);
        OracleCards = catalogue.Oracles.ToString("N0", CultureInfo.CurrentCulture);
        Sets = catalogue.Sets.ToString("N0", CultureInfo.CurrentCulture);
        ImagesCached = cache.Downloaded.ToString("N0", CultureInfo.CurrentCulture);
        ImagesPercent = cache.Percent;
        ImagesCaption = cache.Total == 0 ? "run a sync to list them" : $"of {cache.Total:N0} faces · {cache.Percent:0.0}%";
        ImagesFailed = cache.Failed.ToString("N0", CultureInfo.CurrentCulture);
        DiskUsed = FormatBytes(cache.DownloadedBytes);
        HasFailures = cache.Failed > 0;
        if (!_checkedFreshness && FreshnessText == "Not checked")
        {
            await using var connection = _database.OpenConnection();
            var synced = await connection.ExecuteScalarAsync<string?>("SELECT MAX(synced_at) FROM sync_state");
            FreshnessText = synced is null ? "Never synced" : $"Synced {DescribeAge(ParseUtc(synced))}";
            FreshnessTone = synced is null ? StatusTone.Warning : StatusTone.Neutral;
        }
    }

    private async Task<(long Printings, long Oracles, long Sets)> CountCatalogueAsync()
    {
        await using var connection = _database.OpenConnection();
        return await connection.QuerySingleAsync<(long, long, long)>(
            "SELECT (SELECT COUNT(*) FROM cards), (SELECT COUNT(*) FROM oracle_cards), (SELECT COUNT(*) FROM sets)");
    }

    private async Task RecordRunAsync(DateTime started, string outcome, string summary)
    {
        await using var connection = _database.OpenConnection();
        await connection.ExecuteAsync(
            "INSERT INTO sync_runs (started_at, finished_at, outcome, summary) VALUES ($started, $finished, $outcome, $summary)",
            new { started = started.ToString("o"), finished = DateTime.UtcNow.ToString("o"), outcome, summary });
        await RefreshLastRunAsync();
    }

    private async Task RefreshLastRunAsync()
    {
        await using var connection = _database.OpenConnection();
        var last = await connection.QuerySingleOrDefaultAsync<(string Started, string Finished, string Outcome, string Summary)?>(
            "SELECT started_at, finished_at, outcome, summary FROM sync_runs ORDER BY finished_at DESC LIMIT 1");
        if (last is not { } run) return;
        var started = ParseUtc(run.Started) ?? DateTime.UtcNow;
        var took = (ParseUtc(run.Finished) ?? started) - started;
        LastRunText = $"Last run {started.ToLocalTime():d MMM, HH:mm} · {FormatDuration(took)} · {run.Outcome}. {run.Summary}";
    }

    private void ShowError(string title, Exception error)
    {
        ErrorMessage = $"{title}: {error.Message}";
        _errorDetail = $"{title}{Environment.NewLine}{error}";
        Status = ErrorMessage;
        _applicationLog.Error("scryfall-sync", title, error);
        AppendLog($"{title}: {error.Message}", logToFile: false);
    }

    private void AppendLog(string line, bool logToFile = true)
    {
        if (logToFile) _applicationLog.Information("scryfall-sync", line);
        LiveLog.Add($"{DateTime.Now:HH:mm:ss} {line}");
        while (LiveLog.Count > MaximumLogLines) LiveLog.RemoveAt(0);
    }

    internal static string FormatDuration(TimeSpan value) => value.TotalSeconds < 1
        ? "under a second"
        : value.TotalMinutes < 1 ? $"{value.Seconds}s"
        : value.TotalHours < 1 ? $"{value.Minutes}m {value.Seconds:00}s"
        : $"{(int)value.TotalHours}h {value.Minutes:00}m";

    private static string FormatBytes(long bytes) => bytes switch
    {
        >= 1L << 30 => $"{bytes / (double)(1L << 30):0.0} GB",
        >= 1L << 20 => $"{bytes / (double)(1L << 20):0} MB",
        _ => $"{bytes / 1024.0:0} KB",
    };

    private static string Rate(long count, TimeSpan elapsed) =>
        elapsed.TotalSeconds < 1 ? "instant" : $"{count / elapsed.TotalSeconds:0.0} images/s";

    private static string Signed(long value) => value >= 0 ? $"+{value:N0}" : $"{value:N0}";

    private static string Plural(long count, string noun) => count == 1 ? $"1 {noun}" : $"{count:N0} {noun}s";

    private static string Capitalize(string text) => text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];

    private static DateTime? ParseUtc(string? value) =>
        DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
            out var parsed) ? parsed : null;

    private static string DescribeAge(DateTime? utc)
    {
        if (utc is not { } value) return "never";
        var age = DateTime.UtcNow - value;
        return age.TotalMinutes < 1 ? "just now"
            : age.TotalHours < 1 ? $"{(int)age.TotalMinutes} min ago"
            : age.TotalDays < 1 ? $"{(int)age.TotalHours} h ago"
            : age.TotalDays < 2 ? "yesterday"
            : $"{(int)age.TotalDays} days ago";
    }
}
