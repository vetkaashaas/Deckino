using System.Text.Json.Serialization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;
using Velopack;

namespace Deckino.Toolbox.ViewModels;

public partial class ShellViewModel : ObservableObject
{
    [JsonIgnore]
    public IReadOnlyList<WorkspaceViewModel> Workspaces { get; }

    [ObservableProperty]
    [JsonIgnore]
    [NotifyPropertyChangedFor(nameof(CurrentKey))]
    public partial WorkspaceViewModel CurrentPage { get; set; }

    /// <summary>The open page's <see cref="WorkspaceViewModel.Key"/>.</summary>
    public string CurrentKey => CurrentPage.Key;

    /// <summary>The sidebar's entries.</summary>
    public IReadOnlyList<PageEntry> Pages { get; }

    /// <summary>The sidebar's footer: the Toolbox version, or what the update button is waiting for.</summary>
    [ObservableProperty]
    public partial string VersionStatus { get; private set; } = string.Empty;

    /// <summary>The sidebar's update button: download the update, then restart into it. Null hides it.</summary>
    [ObservableProperty]
    public partial string? UpdateButtonText { get; private set; }

    private static readonly TimeSpan UpdateCheckInterval = TimeSpan.FromMinutes(1);
    private readonly ToolboxUpdateService _updates;
    private readonly TrainingRunSyncService _runs;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly ApplicationLogService _log;
    private readonly IDesktopService _desktop;
    private UpdateInfo? _update;
    private bool _checkFailed; // logs the first failed check only, not one a minute while offline
    private bool _updateDownloaded;

    public ShellViewModel(
        SyncViewModel sync,
        DatasetSyncViewModel datasetSync,
        ModelSyncViewModel modelSync,
        VideoImportViewModel videoImport,
        AnnotatorViewModel annotator,
        CardIdentificationViewModel cardIdentification,
        PhotoLibraryViewModel photoLibrary,
        ExtractionTrainingViewModel extractionTraining,
        RunnerViewModel runner,
        ToolboxUpdateService updates,
        TrainingRunSyncService runs,
        WorkspaceOperationCoordinator coordinator,
        ApplicationLogService log,
        IDesktopService desktop)
    {
        Workspaces = [sync, datasetSync, modelSync, videoImport, annotator, cardIdentification, photoLibrary, extractionTraining, runner];
        Pages = Workspaces.Select(workspace => new PageEntry(workspace.Key, workspace.DisplayName)).ToArray();
        CurrentPage = sync;
        _updates = updates;
        _runs = runs;
        _coordinator = coordinator;
        _log = log;
        _desktop = desktop;
    }

    [RelayCommand]
    private void Open(string key)
    {
        if (Workspaces.FirstOrDefault(workspace => workspace.Key == key) is { } page) CurrentPage = page;
    }

    /// <summary>
    /// From the first window on: look for a Toolbox update now and every minute (the training PC stays open for
    /// days), and once share the newest finished training runs the bucket doesn't have yet (an upload that failed, or
    /// runs from before the bucket was connected).
    /// </summary>
    public async Task StartBackgroundWorkAsync()
    {
        await CheckForUpdateAsync();
        try
        {
            foreach (var version in await _runs.UploadMissingAsync(CancellationToken.None))
                _log.Information("training-runs", $"Uploaded {version} to the bucket.");
        }
        catch (Exception error)
        {
            _log.Error("training-runs", "Uploading the newest training runs failed; the next start tries again.", error);
        }
        if (!_updates.IsInstalled) return;
        using var timer = new PeriodicTimer(UpdateCheckInterval);
        while (await timer.WaitForNextTickAsync()) await CheckForUpdateAsync();
    }

    private async Task CheckForUpdateAsync()
    {
        if (!_updates.IsInstalled)
        {
            VersionStatus = "Development build";
            return;
        }
        if (_update is not null) return; // the button already offers it
        VersionStatus = _updates.CurrentVersion;
        if (!_updates.IsBucketConnected)
        {
            VersionStatus += " · connect the bucket for updates";
            return;
        }
        try
        {
            _update = await _updates.CheckAsync();
            _checkFailed = false;
            if (_update is not null) UpdateButtonText = $"Update to v{_update.TargetFullRelease.Version}";
        }
        catch (Exception error)
        {
            if (!_checkFailed) _log.Error("update", "Toolbox update check failed; it retries every minute.", error);
            _checkFailed = true;
            VersionStatus += " · update check failed; see the log";
        }
    }

    // The button's first click downloads (showing its progress), the second restarts into the new version. The async
    // command disables the button while the download runs, so it cannot start twice.
    [RelayCommand]
    private async Task UpdateAsync()
    {
        if (_update is null) return;
        if (_updateDownloaded)
        {
            // A restart would kill a training run or import; the update still installs at the next start.
            if (_coordinator.IsBusy)
            {
                VersionStatus = $"{_updates.CurrentVersion} · finish or cancel the running job, then restart";
                return;
            }
            _log.Information("update", $"Restarting into v{_update.TargetFullRelease.Version}.");
            _updates.InstallAfterExit(_update);
            _desktop.Quit();
            return;
        }
        UpdateButtonText = "Downloading 0%";
        try
        {
            await _updates.DownloadAsync(_update,
                percent => _desktop.BeginInvoke(() =>
                {
                    if (!_updateDownloaded) UpdateButtonText = $"Downloading {percent}%";
                }),
                CancellationToken.None);
            _updateDownloaded = true;
            UpdateButtonText = "Restart to update";
            VersionStatus = $"{_updates.CurrentVersion} · or it installs at the next start";
        }
        catch (Exception error)
        {
            _log.Error("update", "Downloading the Toolbox update failed.", error);
            UpdateButtonText = $"Update to v{_update.TargetFullRelease.Version}";
            VersionStatus = $"{_updates.CurrentVersion} · download failed; see the log";
        }
    }

    // oldValue is null on the first assignment, despite the generated signature; the type patterns below allow for it.
    partial void OnCurrentPageChanged(WorkspaceViewModel oldValue, WorkspaceViewModel newValue)
    {
        // Identify Card keeps an artwork model loaded only while it is open.
        if (oldValue is CardIdentificationViewModel identification) _ = identification.LeaveAsync();
        if (newValue is IRefreshableWorkspace refreshable) _ = refreshable.RefreshAsync();
    }
}

public sealed record PageEntry(string Key, string DisplayName);
