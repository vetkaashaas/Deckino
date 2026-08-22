using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Dapper;
using Deckino.Tools.Data;
using Deckino.Tools.Services;

namespace Deckino.Tools.ViewModels;

public partial class SyncViewModel : WorkspaceViewModel
{
    private static readonly SolidColorBrush DotIdle = new(Color.FromRgb(0x6E, 0x6E, 0x76));
    private static readonly SolidColorBrush DotWorking = new(Color.FromRgb(0x20, 0x8A, 0xEF));
    private static readonly SolidColorBrush DotDone = new(Color.FromRgb(0x7C, 0xFC, 0x9A));
    private static readonly SolidColorBrush DotFailed = new(Color.FromRgb(0xE0, 0x6C, 0x75));

    private readonly Database _database;
    private readonly BulkDataSyncService _bulkSync;
    private readonly ArtCropDownloadService _artSync;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SyncCommand))]
    [NotifyCanExecuteChangedFor(nameof(CancelCommand))]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    public partial StatusKind Kind { get; set; } = StatusKind.Idle;

    [ObservableProperty]
    public partial string StatusLine { get; set; } = "Idle.";

    [ObservableProperty]
    public partial string StatusDetail { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string ErrorDetail { get; set; } = string.Empty;

    [ObservableProperty]
    public partial SolidColorBrush StatusDotBrush { get; set; } = DotIdle;

    [ObservableProperty]
    public partial double BulkProgressPercent { get; set; }

    [ObservableProperty]
    public partial long CardsInDb { get; set; }

    [ObservableProperty]
    public partial long OracleCardsInDb { get; set; }

    [ObservableProperty]
    public partial long ImagesDone { get; set; }

    [ObservableProperty]
    public partial long ImagesFailed { get; set; }

    [ObservableProperty]
    public partial long ImagesPending { get; set; }

    [ObservableProperty]
    public partial double CacheProgressPercent { get; set; }

    partial void OnImagesDoneChanged(long value) => UpdateCacheProgress();

    partial void OnImagesPendingChanged(long value) => UpdateCacheProgress();

    partial void OnImagesFailedChanged(long value) => UpdateCacheProgress();

    private void UpdateCacheProgress()
    {
        var total = ImagesDone + ImagesPending + ImagesFailed;
        CacheProgressPercent = total == 0
            ? 0
            : Math.Min(100.0, ImagesDone * 100.0 / total);
    }

    public override string DisplayName => "Scryfall Sync";
    public override string Description =>
        "One click pulls Scryfall bulk data into SQLite, then fetches every missing art crop into the local cache.";

    public SyncViewModel(Database database, BulkDataSyncService bulkSync, ArtCropDownloadService artSync)
    {
        _database = database;
        _bulkSync = bulkSync;
        _artSync = artSync;
    }

    partial void OnKindChanged(StatusKind value)
    {
        StatusDotBrush = value switch
        {
            StatusKind.Working => DotWorking,
            StatusKind.Done => DotDone,
            StatusKind.Failed => DotFailed,
            _ => DotIdle,
        };
    }

    private bool CanRun => !IsBusy;

    private bool CanCancel => IsBusy;

    [RelayCommand(CanExecute = nameof(CanRun))]
    private async Task SyncAsync(CancellationToken cancellationToken)
    {
        await RunGuardedAsync("Contacting Scryfall…", async ct =>
        {
            var bulkSummary = await RunBulkPhaseAsync(ct);
            StatusLine = bulkSummary;
            var artSummary = await RunArtPhaseAsync(ct);
            return $"{bulkSummary} {artSummary}";
        }, cancellationToken);
    }

    private async Task<string> RunBulkPhaseAsync(CancellationToken ct)
    {
        Kind = StatusKind.Working;
        StatusLine = "Syncing bulk data…";
        BulkProgressPercent = 0;
        var progress = new Progress<BulkSyncStatus>(status =>
        {
            StatusLine = $"Syncing bulk data — {status.Stage}…";
            if (status.Total is { } total && total > 0)
            {
                BulkProgressPercent = Math.Min(100.0, status.Processed * 100.0 / total);
                StatusDetail = $"{status.Stage}: {status.Processed} / {total} MB";
            }
            else
            {
                StatusDetail = $"{status.Stage}: {status.Processed:N0}";
            }
        });
        var result = await _bulkSync.SyncAllAsync(progress, ct);
        await RefreshCountsAsync();
        return BuildBulkSummary(result);
    }

    private async Task<string> RunArtPhaseAsync(CancellationToken ct)
    {
        var repaired = await _artSync.RepairMissingFilesAsync();
        var pendingAtStart = await _artSync.CountPendingAsync();
        var prefix = repaired > 0 ? $"Re-queued {repaired:N0} missing files. " : string.Empty;
        if (pendingAtStart == 0)
        {
            await RefreshCountsAsync();
            return prefix.Length > 0
                ? $"{prefix}Art cache already complete."
                : "Art cache already complete.";
        }

        StatusLine = $"{prefix}Downloading art crops… {pendingAtStart:N0} queued";
        try
        {
            var progress = new Progress<ArtSyncStatus>(status =>
            {
                ImagesDone = status.Done;
                ImagesFailed = status.Failed;
                ImagesPending = status.Pending;
                StatusDetail = $"downloaded {status.Done:N0} · failed {status.Failed:N0} · left {status.Pending:N0}";
            });
            var result = await _artSync.RunPendingAsync(progress, ct);
            await RefreshCountsAsync();
            return result.Cancelled
                ? $"{prefix}Cancelled with {result.Downloaded:N0} images downloaded this run."
                : $"{prefix}Downloaded {result.Downloaded:N0} art crops ({result.Failed:N0} failed).";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            await RefreshCountsAsync();
            return $"{prefix}Cancelled before finishing downloads.";
        }
    }

    [RelayCommand(CanExecute = nameof(CanCancel))]
    private void Cancel()
    {
        SyncCommand.Cancel();
        StatusLine = "Cancelling…";
    }

    [RelayCommand]
    private void OpenArtFolder()
    {
        var dir = _artSync.CardsDirectory;
        Directory.CreateDirectory(dir);
        Process.Start(new ProcessStartInfo
        {
            FileName = dir,
            UseShellExecute = true,
        });
    }

    [RelayCommand]
    private void CopyError()
    {
        var text = StatusLine;
        if (!string.IsNullOrWhiteSpace(StatusDetail))
        {
            text += $"\n{StatusDetail}";
        }
        if (!string.IsNullOrWhiteSpace(ErrorDetail))
        {
            text += $"\n\n{ErrorDetail}";
        }
        if (!string.IsNullOrWhiteSpace(text))
        {
            Clipboard.SetText(text);
        }
    }

    private async Task RunGuardedAsync(string workingTitle, Func<CancellationToken, Task<string>> run, CancellationToken externalToken)
    {
        IsBusy = true;
        Kind = StatusKind.Working;
        StatusLine = workingTitle;
        StatusDetail = string.Empty;
        ErrorDetail = string.Empty;
        BulkProgressPercent = 0;
        try
        {
            StatusLine = await run(externalToken);
            Kind = StatusKind.Done;
        }
        catch (OperationCanceledException)
        {
            StatusLine = "Cancelled.";
            Kind = StatusKind.Idle;
        }
        catch (Exception ex)
        {
            ErrorDetail = ex.ToString();
            StatusLine = $"Failed: {ex.Message}";
            Kind = StatusKind.Failed;
        }
        finally
        {
            IsBusy = false;
            BulkProgressPercent = 0;
            StatusDetail = string.Empty;
        }
    }

    public async Task RefreshCountsAsync()
    {
        await using var connection = _database.OpenConnection();
        CardsInDb = await connection.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM cards");
        OracleCardsInDb = await connection.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM oracle_cards");
        ImagesDone = await connection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM art_downloads WHERE status = 'downloaded'");
        ImagesFailed = await connection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM art_downloads WHERE status = 'failed'");
        ImagesPending = await connection.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM art_downloads WHERE status = 'pending'");
    }

    private string BuildBulkSummary(BulkSyncResult result)
    {
        var parts = new List<string>();
        if (result.CardsImported > 0)
        {
            parts.Add($"imported {result.CardsImported:N0} cards ({result.SetsUpserted} sets)");
        }
        if (result.OracleCardsImported > 0)
        {
            parts.Add($"{result.OracleCardsImported:N0} oracle cards");
        }
        if (result.SkippedUpToDate.Count > 0)
        {
            parts.Add($"bulk data up to date");
        }
        return parts.Count > 0 ? string.Join(", ", parts) + "." : "Bulk data up to date.";
    }
}
