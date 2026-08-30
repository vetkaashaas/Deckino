using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Tools.Services;
using Microsoft.Win32;
using System.Windows.Media.Imaging;

namespace Deckino.Tools.ViewModels;

public partial class ExtractionTrainingViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private const int MaximumLogLines = 400;
    private const int AutomaticFullCardLimit = 5000;
    private readonly TrainingPaths _paths;
    private readonly TrainingEnvironmentService _environment;
    private readonly ExtractionProductionWorkflowService _workflow;
    private readonly ExtractionAssetDownloadService _assetDownloader;
    private readonly BulkDataSyncService _bulkSync;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly ApplicationLogService _applicationLog;
    private CancellationTokenSource? _activeCancellation;
    private CudaTrainingProfile? _selectedProfile;

    public override string DisplayName => "Card Extraction";
    public override string Description =>
        "Train the independent 320 px geometry-aware four-corner model, primarily from real annotated photos.";

    public ObservableCollection<ProductionStageResult> Stages { get; } = [];
    public ObservableCollection<string> LiveLog { get; } = [];

    [ObservableProperty] public partial string DatasetVersion { get; private set; } = ExtractionProductionWorkflowService.DatasetVersion;
    [ObservableProperty] public partial string ModelVersion { get; private set; } = ExtractionProductionWorkflowService.InitialModelVersion;
    [ObservableProperty] public partial string Status { get; private set; } = "Ready to inspect the extraction workspace.";
    [ObservableProperty] public partial string AssetSummary { get; private set; } = "Synthetic cards are off; no full-card cache is needed.";
    [ObservableProperty] public partial bool IncludeSyntheticCards { get; set; }
    [ObservableProperty] public partial string DiagnosticImagePath { get; set; } = string.Empty;
    [ObservableProperty] public partial string DiagnosticOutputPath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string DiagnosticOverlayPath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string RectifiedPreviewPath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string RecognitionCropPreviewPath { get; private set; } = string.Empty;
    [ObservableProperty] public partial BitmapSource? DiagnosticOverlayPreview { get; private set; }
    [ObservableProperty] public partial BitmapSource? RectifiedPreview { get; private set; }
    [ObservableProperty] public partial BitmapSource? RecognitionCropPreview { get; private set; }
    [ObservableProperty] public partial string DiagnosticCropStatus { get; private set; } = "Run a preview to create the rectified crops.";
    [ObservableProperty] public partial string DiagnosticSummary { get; private set; } = "No diagnostic has been run.";
    [ObservableProperty] public partial string? SelectedLogLine { get; set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial bool EnvironmentReady { get; private set; }
    [ObservableProperty] public partial string GpuSummary { get; private set; } = "CUDA profile not checked.";

    public bool CanRun => !IsBusy && EnvironmentReady;
    public bool CanChangeTrainingOptions => !IsBusy;
    public bool CanCancel => IsBusy;
    public bool CanRunDiagnostic => CanRun && !string.IsNullOrWhiteSpace(DiagnosticImagePath)
        && File.Exists(DiagnosticImagePath);

    public ExtractionTrainingViewModel(
        TrainingPaths paths,
        TrainingEnvironmentService environment,
        ExtractionProductionWorkflowService workflow,
        ExtractionAssetDownloadService assetDownloader,
        BulkDataSyncService bulkSync,
        WorkspaceOperationCoordinator coordinator,
        ApplicationLogService applicationLog)
    {
        _paths = paths;
        _environment = environment;
        _workflow = workflow;
        _assetDownloader = assetDownloader;
        _bulkSync = bulkSync;
        _coordinator = coordinator;
        _applicationLog = applicationLog;
        ApplySnapshot(_workflow.Inspect());
    }

    public async Task RefreshAsync()
    {
        if (IsBusy) return;
        try
        {
            var readiness = await _environment.CheckAsync((_, _) => { }, CancellationToken.None);
            _selectedProfile = readiness.GpuIndex is int gpuIndex
                && readiness.GpuName is not null
                && readiness.VramMiB is long vramMiB
                ? TrainingEnvironmentService.CreateTrainingProfile(gpuIndex, readiness.GpuName, vramMiB)
                : null;
            EnvironmentReady = readiness.Ready && _selectedProfile is not null;
            GpuSummary = _selectedProfile is null
                ? "A compatible NVIDIA CUDA profile is not ready."
                : $"{_selectedProfile.GpuName} · {_selectedProfile.VramMiB:N0} MiB · extraction batch "
                  + $"{(_selectedProfile.VramMiB >= 7680 ? Math.Min(_selectedProfile.BatchSize, 32) : Math.Min(_selectedProfile.BatchSize, 16))}";
            if (IncludeSyntheticCards)
            {
                var assets = await _assetDownloader.InspectAsync(CancellationToken.None);
                AssetSummary = assets.Available == 0
                    ? "Full-card assets will be discovered automatically when training starts."
                    : $"{assets.Downloaded:N0} / {assets.Available:N0} full cards cached · "
                      + $"about {assets.EstimatedRemainingBytes / 1073741824d:N1} GiB remaining";
            }
            ApplySnapshot(_workflow.Inspect());
        }
        catch (Exception error)
        {
            Status = error.Message;
            _applicationLog.Error("extraction-refresh", "Could not refresh extraction readiness.", error);
        }
        NotifyCommandState();
    }

    [RelayCommand(CanExecute = nameof(CanRun))]
    private async Task RunFullAsync() => await RunWorkflowAsync();

    [RelayCommand]
    private void PickDiagnosticImage()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Choose an owned camera photograph",
            Filter = "Images|*.jpg;*.jpeg;*.png",
            InitialDirectory = Directory.Exists(_paths.CameraImportsRoot) ? _paths.CameraImportsRoot : _paths.DataRoot,
        };
        if (dialog.ShowDialog() == true) DiagnosticImagePath = dialog.FileName;
    }

    [RelayCommand(CanExecute = nameof(CanRunDiagnostic))]
    private async Task RunDiagnosticAsync() => await RunGuardedAsync("run extraction diagnostic", async token =>
    {
        if (_selectedProfile is null) throw new InvalidOperationException("Check CUDA readiness first.");
        DiagnosticOverlayPath = string.Empty;
        RectifiedPreviewPath = string.Empty;
        RecognitionCropPreviewPath = string.Empty;
        DiagnosticOverlayPreview = null;
        RectifiedPreview = null;
        RecognitionCropPreview = null;
        DiagnosticCropStatus = "Running extraction preview…";
        DiagnosticOutputPath = await _workflow.RunDiagnosticAsync(
            DiagnosticImagePath, _selectedProfile, AppendLog, token);
        DiagnosticOverlayPath = Path.Combine(DiagnosticOutputPath, "overlay.jpg");
        var rectified = Path.Combine(DiagnosticOutputPath, "rectified-with-identity-crop.jpg");
        var crop = Path.Combine(DiagnosticOutputPath, "recognition-crop-v1.jpg");
        RectifiedPreviewPath = File.Exists(rectified) ? rectified : string.Empty;
        RecognitionCropPreviewPath = File.Exists(crop) ? crop : string.Empty;
        DiagnosticOverlayPreview = LoadUnlockedBitmap(DiagnosticOverlayPath);
        RectifiedPreview = LoadUnlockedBitmap(RectifiedPreviewPath);
        RecognitionCropPreview = LoadUnlockedBitmap(RecognitionCropPreviewPath);
        using (var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(DiagnosticOutputPath, "diagnostic.json"))))
        {
            var diagnostic = document.RootElement;
            var probability = diagnostic.GetProperty("presence_probability").GetDouble();
            var threshold = diagnostic.TryGetProperty("presence_threshold", out var thresholdElement)
                ? thresholdElement.GetDouble()
                : double.NaN;
            var accepted = diagnostic.GetProperty("accepted").GetBoolean();
            var diagnosticModel = diagnostic.GetProperty("model_version").GetString() ?? "unknown model";
            var selectedEpoch = diagnostic.TryGetProperty("selected_epoch", out var epochElement)
                && epochElement.ValueKind == JsonValueKind.Number ? epochElement.GetInt32().ToString("N0") : "unknown epoch";
            var checkpointHash = diagnostic.TryGetProperty("checkpoint_sha256", out var hashElement)
                ? hashElement.GetString() : null;
            var modelEvidence = $"{diagnosticModel} · epoch {selectedEpoch}"
                + (string.IsNullOrWhiteSpace(checkpointHash) ? string.Empty
                    : $" · SHA {checkpointHash![..Math.Min(12, checkpointHash.Length)]}");
            var reason = diagnostic.TryGetProperty("geometry_rejection_reason", out var rejection)
                && rejection.ValueKind == JsonValueKind.String ? rejection.GetString() : null;
            if (accepted)
            {
                DiagnosticSummary = $"Accepted · presence {probability:P1} · valid upright warp · {modelEvidence}";
                DiagnosticCropStatus = string.Empty;
            }
            else if (reason == "presence_below_threshold")
            {
                var thresholdText = double.IsFinite(threshold) ? $", needs {threshold:P1}" : string.Empty;
                DiagnosticSummary = $"Rejected · presence {probability:P1}{thresholdText} · {modelEvidence}";
                DiagnosticCropStatus = "No crops generated because card presence was below the calibrated threshold.";
            }
            else if (reason == "ambiguous_card_geometry")
            {
                DiagnosticSummary = $"Rejected · presence {probability:P1} · ambiguous card geometry · {modelEvidence}";
                DiagnosticCropStatus = "No crops generated because multiple corner combinations were similarly plausible.";
            }
            else
            {
                DiagnosticSummary = $"Rejected · presence {probability:P1} · invalid quadrilateral · {modelEvidence}";
                DiagnosticCropStatus = "No crops generated because the predicted corners could not form a safe warp.";
            }
            if (diagnostic.TryGetProperty("calibrated", out var calibrated) && !calibrated.GetBoolean())
                DiagnosticSummary += " · uncalibrated development threshold";
            else if (diagnostic.TryGetProperty("calibration_provisional", out var provisional) && provisional.GetBoolean())
                DiagnosticSummary += " · provisional calibration (limited negatives)";
        }
        Status = $"Diagnostic written to {DiagnosticOutputPath}";
    });

    [RelayCommand(CanExecute = nameof(CanCancel))]
    private void Cancel() => _activeCancellation?.Cancel();

    [RelayCommand]
    private void OpenExtractionFolder()
    {
        Directory.CreateDirectory(_paths.ExtractionRoot);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(_paths.ExtractionRoot)
        { UseShellExecute = true });
    }

    [RelayCommand]
    private void OpenLogFolder()
    {
        Directory.CreateDirectory(_paths.LogsRoot);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(_paths.LogsRoot)
        { UseShellExecute = true });
    }

    [RelayCommand]
    private void CopySelectedLog()
    {
        if (!string.IsNullOrWhiteSpace(SelectedLogLine))
            System.Windows.Clipboard.SetText(SelectedLogLine);
    }

    [RelayCommand]
    private void CopyAllLogs()
    {
        var text = string.Join(Environment.NewLine, LiveLog);
        if (!string.IsNullOrWhiteSpace(text)) System.Windows.Clipboard.SetText(text);
    }

    [RelayCommand]
    private void ClearAllLogs()
    {
        var confirmed = System.Windows.MessageBox.Show(
            "Clear the visible activity log and delete the current Deckino.Tools log file?",
            "Clear activity log",
            System.Windows.MessageBoxButton.YesNo,
            System.Windows.MessageBoxImage.Warning) == System.Windows.MessageBoxResult.Yes;
        if (!confirmed) return;

        try
        {
            _applicationLog.ClearCurrentLog();
            LiveLog.Clear();
            SelectedLogLine = null;
            Status = "Activity log cleared.";
        }
        catch (Exception exception)
        {
            Status = $"Could not clear the activity log: {exception.Message}";
        }
    }

    private async Task RunWorkflowAsync() => await RunGuardedAsync(
        "run full extraction workflow",
        async token =>
        {
            if (_selectedProfile is null) throw new InvalidOperationException("Check CUDA readiness first.");
            var includeSyntheticCards = IncludeSyntheticCards;
            if (includeSyntheticCards)
            {
                try
                {
                    await EnsureAutomaticFullCardCacheAsync(token);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception error)
                {
                    AssetSummary = "Full-card download unavailable; continuing with imports and any existing synthetic source assets.";
                    AppendLog($"warning: automatic full-card cache skipped: {error.Message}", null);
                }
            }
            else
            {
                AssetSummary = "Synthetic cards are off; no full-card cache is needed.";
                AppendLog("Synthetic cards disabled: skipping Scryfall discovery, downloads, and generated scenes.", null);
            }
            var snapshot = await _workflow.RunAsync(_selectedProfile, AppendLog, ApplySnapshot, token, includeSyntheticCards);
            ApplySnapshot(snapshot);
        });

    private async Task EnsureAutomaticFullCardCacheAsync(CancellationToken cancellationToken)
    {
        var cache = await _assetDownloader.InspectAsync(cancellationToken);
        if (cache.Available == 0)
        {
            Status = "Discovering full-card assets from the latest Scryfall catalog…";
            var syncProgress = new Progress<BulkSyncStatus>(value =>
                Status = $"Scryfall catalog · {value.Stage} · {value.Processed:N0}"
                    + (value.Total is { } total ? $" / {total:N0}" : string.Empty));
            await _bulkSync.SyncAllAsync(syncProgress, cancellationToken);
            cache = await _assetDownloader.InspectAsync(cancellationToken);
        }

        var remaining = Math.Max(0, AutomaticFullCardLimit - cache.Downloaded);
        if (remaining > 0 && cache.Available > cache.Downloaded)
        {
            Status = $"Caching up to {AutomaticFullCardLimit:N0} full cards for synthetic training scenes…";
            var downloadProgress = new Progress<ExtractionAssetDownloadProgress>(value =>
                Status = $"Full-card cache · {value.Completed:N0} downloaded · "
                    + $"{value.Failed:N0} failed · {value.Remaining:N0} remaining");
            cache = await _assetDownloader.DownloadPendingAsync((int)Math.Min(int.MaxValue, remaining),
                downloadProgress, cancellationToken);
        }

        AssetSummary = cache.Available == 0
            ? "No Scryfall full-card assets were available; using annotated photos only."
            : $"{cache.Downloaded:N0} / {cache.Available:N0} full cards cached automatically";
    }

    private async Task RunGuardedAsync(string operation, Func<CancellationToken, Task> action)
    {
        if (IsBusy) return;
        _activeCancellation = new CancellationTokenSource();
        IsBusy = true; NotifyCommandState();
        string? terminalStatus = null;
        try
        {
            using var lease = await _coordinator.AcquireAsync(operation, _activeCancellation.Token);
            await action(_activeCancellation.Token);
            terminalStatus = Status;
        }
        catch (OperationCanceledException)
        {
            terminalStatus = "Cancelled safely. Completed stages and checkpoints were retained.";
        }
        catch (Exception error)
        {
            terminalStatus = error.Message;
            if (operation == "run extraction diagnostic")
                DiagnosticCropStatus = $"Preview failed: {error.Message}";
            _applicationLog.Error("extraction", operation + " failed.", error);
        }
        finally
        {
            _activeCancellation.Dispose(); _activeCancellation = null;
            IsBusy = false;
            try { ApplySnapshot(_workflow.Inspect()); } catch { }
            if (!string.IsNullOrWhiteSpace(terminalStatus)) Status = terminalStatus;
            NotifyCommandState();
        }
    }

    internal static BitmapSource? LoadUnlockedBitmap(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var bitmap = BitmapFrame.Create(
            stream,
            BitmapCreateOptions.PreservePixelFormat,
            BitmapCacheOption.OnLoad);
        bitmap.Freeze();
        return bitmap;
    }

    private void AppendLog(string line, JsonElement? parsed)
    {
        _applicationLog.Information("extraction-training", line);
        var display = parsed is { } value && value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty("event", out var eventName)
            ? $"{DateTime.Now:HH:mm:ss} {eventName.GetString()} · {line}"
            : $"{DateTime.Now:HH:mm:ss} {line}";
        App.Current.Dispatcher.BeginInvoke(() =>
        {
            LiveLog.Add(display);
            while (LiveLog.Count > MaximumLogLines) LiveLog.RemoveAt(0);
            if (parsed is { } progress && progress.ValueKind == JsonValueKind.Object
                && progress.TryGetProperty("event", out var name))
            {
                Status = name.GetString() switch
                {
                    "extraction_preparation_progress" =>
                        $"{progress.GetProperty("detail").GetString()} · "
                        + $"{progress.GetProperty("completed").GetInt32():N0} / "
                        + $"{progress.GetProperty("total").GetInt32():N0}",
                    "extraction_training_progress" =>
                        $"Geometry training epoch {progress.GetProperty("phase_epoch").GetInt32():N0} / "
                        + $"{progress.GetProperty("phase_epochs").GetInt32():N0} · batch "
                        + $"{progress.GetProperty("batch").GetInt32():N0} / "
                        + $"{progress.GetProperty("total_batches").GetInt32():N0}",
                    "extraction_validation_progress" =>
                        $"Validating epoch {progress.GetProperty("epoch").GetInt32():N0} / "
                        + $"{progress.GetProperty("epochs").GetInt32():N0} · batch "
                        + $"{progress.GetProperty("batch").GetInt32():N0} / "
                        + $"{progress.GetProperty("total_batches").GetInt32():N0}",
                    "extraction_evaluation_progress" =>
                        $"{progress.GetProperty("phase").GetString()} · "
                        + $"{progress.GetProperty("completed_samples").GetInt32():N0} / "
                        + $"{progress.GetProperty("total_samples").GetInt32():N0}",
                    "extraction_epoch_completed" =>
                        $"Completed epoch {progress.GetProperty("epoch").GetInt32():N0} · "
                        + (progress.GetProperty("selected").GetBoolean() ? "selected new best extractor" : "retained previous best extractor"),
                    "extraction_heatmap_progress" =>
                        $"Writing corner heatmaps · {progress.GetProperty("completed").GetInt32()} / {progress.GetProperty("total").GetInt32()}",
                    "extraction_baseline_compared" => progress.GetProperty("status").GetString() == "compared"
                        ? "Baseline comparison completed on the same real validation photographs."
                        : $"Baseline comparison unavailable: {progress.GetProperty("reason").GetString()}",
                    "extraction_sampling_warning" => progress.GetProperty("message").GetString() ?? Status,
                    "extraction_learning_progress" =>
                        $"Real-photo learning check · {progress.GetProperty("updates").GetInt32():N0} / "
                        + $"{progress.GetProperty("maximum_updates").GetInt32():N0} updates",
                    "extraction_learning_completed" => "Real-photo learning and checkpoint inference check passed.",
                    "extraction_amp_overflow" => progress.GetProperty("retrying").GetBoolean()
                        ? $"AMP overflow · retry {progress.GetProperty("retry").GetInt32()} / "
                            + $"{progress.GetProperty("maximum_retries").GetInt32()} · "
                            + $"loss scale {progress.GetProperty("loss_scale").GetDouble():G4}"
                        : "AMP overflow recovery exhausted · stopping safely",
                    "extraction_cuda_smoke_completed" => "Extractor CUDA validation passed.",
                    "extraction_dataset_prepared" =>
                        $"Prepared {progress.GetProperty("records").GetInt32():N0} extraction samples.",
                    "extraction_evaluated" => "Extraction evaluation completed.",
                    "extraction_rectified" => "Rectification preview completed.",
                    _ => Status,
                };
            }
        });
    }

    private void ApplySnapshot(ExtractionWorkflowSnapshot snapshot)
    {
        DatasetVersion = snapshot.DatasetVersion;
        ModelVersion = snapshot.ModelVersion;
        Status = snapshot.Summary;
        Stages.Clear();
        foreach (var stage in snapshot.Stages) Stages.Add(stage);
        NotifyCommandState();
    }

    partial void OnIsBusyChanged(bool value)
    {
        NotifyCommandState();
    }
    partial void OnDiagnosticImagePathChanged(string value) => NotifyCommandState();
    partial void OnIncludeSyntheticCardsChanged(bool value)
    {
        AssetSummary = value
            ? "Synthetic cards are on; full-card assets will be cached automatically when training starts."
            : "Synthetic cards are off; no full-card cache is needed.";
    }
    private void NotifyCommandState()
    {
        OnPropertyChanged(nameof(CanRun));
        OnPropertyChanged(nameof(CanChangeTrainingOptions));
        OnPropertyChanged(nameof(CanCancel));
        OnPropertyChanged(nameof(CanRunDiagnostic));
        RunFullCommand.NotifyCanExecuteChanged();
        RunDiagnosticCommand.NotifyCanExecuteChanged();
        CancelCommand.NotifyCanExecuteChanged();
    }
}
