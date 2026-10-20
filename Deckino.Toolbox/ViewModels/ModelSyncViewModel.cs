using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

/// <summary>Training runs from the bucket, and the models the app downloads. The bucket connection lives on Dataset Sync.</summary>
public partial class ModelSyncViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly ICameraDatasetSyncService _sync;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly ModelPublishService _publisher;
    private readonly TrainingRunSyncService _runs;

    public override string DisplayName => "Model Sync";
    public override string Description =>
        "Pull training runs from the bucket to this PC, and publish the current models for the app to download.";

    public ObservableCollection<TrainingRunItem> Runs { get; } = [];

    [ObservableProperty] public partial TrainingRunItem? SelectedRun { get; set; }
    [ObservableProperty] public partial string RunsStatus { get; private set; } = "Connect the bucket on Dataset Sync to see the training runs.";
    [ObservableProperty] public partial bool IsConfigured { get; private set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }
    // The pull's bar: how much of the run has downloaded, 100 while it imports; null hides it.
    [ObservableProperty] public partial int? PullPercent { get; private set; }
    // What Publish would send: this PC's current model of each kind, if it has one.
    [ObservableProperty] public partial string? CurrentExtractor { get; private set; }
    [ObservableProperty] public partial string? CurrentArtwork { get; private set; }
    [ObservableProperty] public partial string PublishStatus { get; private set; } =
        "Makes the current model's phone files, checks the app's own code against them, then publishes it. Apps download it on Wi-Fi at their next start.";

    public ModelSyncViewModel(
        ICameraDatasetSyncService sync,
        WorkspaceOperationCoordinator coordinator,
        ModelPublishService publisher,
        TrainingRunSyncService runs)
    {
        _sync = sync;
        _coordinator = coordinator;
        _publisher = publisher;
        _runs = runs;
    }

    // The connection is saved on Dataset Sync, so it is read again each time this page opens.
    public async Task RefreshAsync()
    {
        ReadCurrentVersions();
        IsConfigured = _sync.GetSnapshot().IsConfigured;
        if (!IsConfigured) RunsStatus = "Connect the bucket on Dataset Sync to see the training runs.";
        else if (!IsBusy) await LoadRunsAsync();
    }

    [RelayCommand(CanExecute = nameof(CanUseBucket))]
    private async Task RefreshRunsAsync()
    {
        IsBusy = true;
        try
        {
            await LoadRunsAsync();
        }
        finally
        {
            IsBusy = false;
        }
    }

    // Pulls a run from the bucket and imports it: it becomes this PC's current model of its kind (Card
    // Identification and the annotator's suggestions use it, Build phone files exports it).
    [RelayCommand(CanExecute = nameof(CanPullRun))]
    private async Task PullRunAsync()
    {
        if (SelectedRun is not { } item) return;
        try
        {
            IsBusy = true;
            var size = item.Run.Bytes / 1_048_576.0;
            RunsStatus = $"Downloading {item.Run.ModelVersion} ({size:N1} MB)…";
            PullPercent = 0;
            // The bucket reports from its own thread, many times per percent: only a new percent reaches the page.
            IProgress<int> progress = new Progress<int>(percent =>
            {
                if (percent == PullPercent) return;
                PullPercent = percent;
                RunsStatus = percent < 100
                    ? $"Downloading {item.Run.ModelVersion}: {size * percent / 100:N1} of {size:N1} MB…"
                    : $"Importing {item.Run.ModelVersion}…";
            });
            using (await _coordinator.AcquireAsync("import a training run", CancellationToken.None))
                RunsStatus = $"Imported {await _runs.SyncDownAsync(item.Run, CancellationToken.None, progress.Report)}. "
                    + $"It is this PC's current {item.Run.Kind} model.";
            ShowRuns(Runs.Select(run => run.Run).ToList());
        }
        catch (Exception error)
        {
            RunsStatus = $"Pull failed: {DatasetSyncViewModel.Redact(error, _sync)}";
        }
        finally
        {
            IsBusy = false;
            PullPercent = null;
        }
    }

    private async Task LoadRunsAsync()
    {
        try
        {
            RunsStatus = "Listing the training runs in the bucket…";
            var runs = await _runs.ListAsync(CancellationToken.None);
            ShowRuns(runs);
            RunsStatus = runs.Count == 0
                ? "No training runs in the bucket yet. A finished run on the training PC uploads itself."
                : $"{runs.Count:N0} runs in the bucket, newest first.";
        }
        catch (Exception error)
        {
            RunsStatus = $"Could not list the training runs: {DatasetSyncViewModel.Redact(error, _sync)}";
        }
    }

    private void ShowRuns(IReadOnlyList<BucketTrainingRun> runs)
    {
        ReadCurrentVersions();
        var current = new Dictionary<string, string?>
        {
            [TrainingRunSyncService.ArtworkKind] = CurrentArtwork,
            [TrainingRunSyncService.ExtractionKind] = CurrentExtractor,
        };
        var selected = SelectedRun?.Run;
        Runs.Clear();
        foreach (var run in runs)
            Runs.Add(new TrainingRunItem(run, $"{run.Bytes / 1_048_576.0:N1} MB"
                + (current[run.Kind] == run.ModelVersion ? " · current on this PC" : string.Empty)));
        SelectedRun = Runs.FirstOrDefault(item => item.Run == selected) ?? Runs.FirstOrDefault();
    }

    private void ReadCurrentVersions()
    {
        CurrentArtwork = _runs.CurrentVersion(TrainingRunSyncService.ArtworkKind);
        CurrentExtractor = _runs.CurrentVersion(TrainingRunSyncService.ExtractionKind);
    }

    [RelayCommand(CanExecute = nameof(CanUseBucket))]
    private Task PublishArtworkAsync() => PublishAsync("artwork");

    [RelayCommand(CanExecute = nameof(CanUseBucket))]
    private Task PublishExtractorAsync() => PublishAsync("extractor");

    private async Task PublishAsync(string kind)
    {
        try
        {
            IsBusy = true;
            PublishStatus = $"Publishing the current {kind} model…";
            var published = await _publisher.PublishAsync(
                kind, line => PublishStatus = $"Publishing the current {kind} model: {line}", CancellationToken.None);
            PublishStatus = $"Published {published.ModelVersion} (schema {published.Schema}, {published.Bytes / 1_048_576.0:N1} MB). "
                + "Apps built for that schema download it on Wi-Fi at their next start.";
        }
        catch (Exception error)
        {
            PublishStatus = $"Publish failed: {DatasetSyncViewModel.Redact(error, _sync)}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private bool CanUseBucket() => !IsBusy && IsConfigured;
    private bool CanPullRun() => !IsBusy && SelectedRun is not null;

    private void NotifyCommands()
    {
        RefreshRunsCommand.NotifyCanExecuteChanged();
        PullRunCommand.NotifyCanExecuteChanged();
        PublishArtworkCommand.NotifyCanExecuteChanged();
        PublishExtractorCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();
    partial void OnIsConfiguredChanged(bool value) => NotifyCommands();
    partial void OnSelectedRunChanged(TrainingRunItem? value) => NotifyCommands();
}

public sealed record TrainingRunItem(BucketTrainingRun Run, string Detail);
