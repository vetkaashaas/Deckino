using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Dapper;
using Deckino.Tools.Data;
using Deckino.Tools.Services;
using Microsoft.Win32;

namespace Deckino.Tools.ViewModels;

public partial class RunnerViewModel : WorkspaceViewModel
{
    private const int MaximumLogLines = 400;
    private readonly Database _database;
    private readonly TrainingPaths _paths;
    private readonly TrainingEnvironmentService _environment;
    private readonly PythonProcessRunner _runner;
    private readonly TrainingResultExporter _exporter;
    private readonly IdentityProductionWorkflowService _identityProduction;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly ApplicationLogService _applicationLog;
    private CancellationTokenSource? _activeCancellation;
    private bool _automaticRequirementsCheckCompleted;
    private CudaTrainingProfile? _selectedProfile;

    public override string DisplayName => "Model Training";
    public override string Description =>
        "Qualify the offline artwork recognizer on a compatible NVIDIA CUDA GPU.";

    public ObservableCollection<string> LiveLog { get; } = [];
    public ObservableCollection<RequirementCheckItem> RequirementChecks { get; } = [];
    public ObservableCollection<ProductionStageResult> ProductionStages { get; } = [];

    [ObservableProperty] public partial string DatasetVersion { get; set; } = "paper-art-v4";
    [ObservableProperty] public partial string ModelVersion { get; set; } = "mobilenetv3s-512-art-v4";
    [ObservableProperty] public partial string CameraVersion { get; set; } = "camera-v1";
    [ObservableProperty] public partial string? CameraCaptureFolder { get; set; }
    [ObservableProperty] public partial string? RecognitionImage { get; set; }
    [ObservableProperty] public partial string? SelectedLogLine { get; set; }
    [ObservableProperty] public partial string Status { get; set; } = "Check requirements to begin.";
    [ObservableProperty] public partial string RequirementsSummary { get; set; } = "Not checked";
    [ObservableProperty] public partial string RequirementsHeadline { get; set; } = "Readiness not checked";
    [ObservableProperty] public partial string RequirementsCaption { get; set; } = "Run the check to inspect this laptop without installing anything.";
    [ObservableProperty] public partial bool EnvironmentReady { get; set; }
    [ObservableProperty] public partial bool CanInstallPackages { get; set; } = true;
    [ObservableProperty] public partial bool ShowRequirementDetails { get; set; }
    [ObservableProperty] public partial bool IsBusy { get; set; }
    [ObservableProperty] public partial bool PackagesReady { get; set; }
    [ObservableProperty] public partial bool PaperCacheReady { get; set; }
    [ObservableProperty] public partial bool CanPrepareDataset { get; set; }
    [ObservableProperty] public partial bool DatasetReady { get; set; }
    [ObservableProperty] public partial bool CudaSmokeReady { get; set; }
    [ObservableProperty] public partial bool TrainingReady { get; set; }
    [ObservableProperty] public partial bool EvaluationReady { get; set; }
    [ObservableProperty] public partial bool CanTrainProduction { get; set; }
    [ObservableProperty] public partial bool CanRunProduction { get; set; }
    [ObservableProperty] public partial string ProductionActionHint { get; set; }
        = "Complete Environment Readiness before starting artwork qualification.";
    [ObservableProperty] public partial bool CanStartNewModelVersion { get; set; }
    [ObservableProperty] public partial bool ShowRunDetails { get; set; }
    [ObservableProperty] public partial ProductionWorkflowOutcome ProductionOutcome { get; set; }
        = ProductionWorkflowOutcome.Ready;
    [ObservableProperty] public partial string ProductionSummary { get; set; }
        = "Ready to measure artwork-prototype retrieval.";
    [ObservableProperty] public partial string ProductionRunDetails { get; set; }
        = "GPU profile will be selected during the requirements check.";
    [ObservableProperty] public partial string? ProductionExportPath { get; set; }

    public RunnerViewModel(
        Database database,
        TrainingPaths paths,
        TrainingEnvironmentService environment,
        PythonProcessRunner runner,
        TrainingResultExporter exporter,
        IdentityProductionWorkflowService identityProduction,
        WorkspaceOperationCoordinator coordinator,
        ApplicationLogService applicationLog)
    {
        _database = database;
        _paths = paths;
        _environment = environment;
        _runner = runner;
        _exporter = exporter;
        _identityProduction = identityProduction;
        _coordinator = coordinator;
        _applicationLog = applicationLog;
        SetPendingRequirements();
        RefreshStageState();
        RefreshProductionState();
    }

    partial void OnDatasetVersionChanged(string value)
    {
        RefreshStageState();
    }
    partial void OnModelVersionChanged(string value) => RefreshStageState();
    partial void OnPackagesReadyChanged(bool value) => UpdatePrepareGate();
    partial void OnPaperCacheReadyChanged(bool value) => UpdatePrepareGate();
    partial void OnEnvironmentReadyChanged(bool value) => UpdateProductionGate();
    partial void OnIsBusyChanged(bool value) => UpdateProductionGate();

    [RelayCommand]
    private async Task CheckRequirementsAsync() => await RefreshRequirementsAsync(showDetails: true);

    public async Task EnsureQuickRequirementsCheckAsync()
    {
        if (_automaticRequirementsCheckCompleted) return;
        _automaticRequirementsCheckCompleted = true;
        await RefreshRequirementsAsync(showDetails: false);
    }

    private async Task RefreshRequirementsAsync(bool showDetails)
    {
        if (showDetails) ShowRequirementDetails = true;
        await RunGuardedAsync("Checking Python, CUDA, and disk space…", async cancellationToken =>
        {
            var readiness = await _environment.CheckAsync(AppendLog, cancellationToken);
            await ApplyReadinessAsync(readiness);
            return readiness.Ready
                ? "Requirements are ready."
                : "Requirements are not ready; install packages or review the diagnostics.";
        }, coordinate: false);
    }

    [RelayCommand]
    private async Task InstallPackagesAsync()
    {
        TrainingReadiness readiness;
        try
        {
            readiness = await _environment.CheckAsync(AppendLog, CancellationToken.None);
        }
        catch (Exception error)
        {
            Status = $"Requirements check failed: {error.Message}";
            AppendLog(error.ToString(), null);
            return;
        }
        var allowPythonInstall = true;
        if (readiness.PythonPath is null)
        {
            allowPythonInstall = MessageBox.Show(
                "Python 3.12 x64 was not found. Install signed Python 3.12.10 into Deckino's private local runtime? No PATH entries or shortcuts will be created.",
                "Install private Python",
                MessageBoxButton.YesNo,
                MessageBoxImage.Question) == MessageBoxResult.Yes;
            if (!allowPythonInstall)
            {
                Status = "Python installation cancelled.";
                return;
            }
        }
        await RunGuardedAsync("Installing the local CUDA training runtime…", async cancellationToken =>
        {
            await _environment.InstallAsync(allowPythonInstall, AppendLog, cancellationToken);
            var updated = await _environment.CheckAsync(AppendLog, cancellationToken);
            await ApplyReadinessAsync(updated);
            if (!updated.Ready)
            {
                throw new InvalidOperationException("Installation completed, but the compatible NVIDIA CUDA requirement is not satisfied.");
            }
            return "CUDA training runtime is ready.";
        });
    }

    [RelayCommand]
    private async Task PrepareDatasetAsync() => await RunPythonStageAsync(
        "Preparing the no-copy dataset manifest…",
        ["prepare", "--data-root", _paths.DataRoot, "--dataset-version", DatasetVersion],
        $"prepare-{DatasetVersion}",
        () => File.Exists(_paths.ManifestPath(DatasetVersion)),
        "Dataset manifest is ready.");

    [RelayCommand]
    private async Task RunCudaSmokeAsync() => await RunPythonStageAsync(
        "Running batch-64 CUDA smoke…",
        ["accelerator-smoke", "--manifest", _paths.ManifestPath(DatasetVersion), "--device", "cuda", "--batch-size", "64", "--embedding-dim", "512", "--steps", "2"],
        $"cuda-smoke-{DatasetVersion}",
        () =>
        {
            Directory.CreateDirectory(_paths.TrainingRoot);
            File.WriteAllText(SmokeMarkerPath, DatasetVersion);
            return true;
        },
        "CUDA smoke passed.");

    [RelayCommand]
    private async Task TrainAsync()
    {
        var arguments = new List<string>
        {
            "train", "--manifest", _paths.ManifestPath(DatasetVersion),
            "--artifacts-root", _paths.ArtifactsRoot,
            "--model-version", ModelVersion,
            "--device", "cuda", "--batch-size", "64", "--epochs", "20",
            "--workers", "4", "--embedding-dim", "512", "--learning-rate", "3e-4", "--pretrained",
        };
        var lastCheckpoint = Path.Combine(_paths.ArtifactRoot(ModelVersion), "last.pt");
        if (File.Exists(lastCheckpoint))
        {
            arguments.AddRange(["--resume", lastCheckpoint]);
        }
        await RunPythonStageAsync(
            File.Exists(lastCheckpoint) ? "Resuming training…" : "Training the recognition model…",
            arguments,
            $"{ModelVersion}-train",
            () => File.Exists(lastCheckpoint),
            "Training completed.");
    }

    [RelayCommand]
    private async Task RunProductionAsync()
    {
        await RunGuardedAsync("Running the full identity workflow…", async cancellationToken =>
        {
            var profile = _selectedProfile
                ?? throw new InvalidOperationException("Check requirements to select a compatible NVIDIA GPU.");
            await EnsurePaperCacheCompleteAsync();
            var snapshot = await _identityProduction.RunAsync(
                profile,
                AppendLog,
                value => Application.Current.Dispatcher.BeginInvoke(() => ApplyProductionSnapshot(value)),
                cancellationToken);
            ApplyProductionSnapshot(snapshot);
            return snapshot.Outcome switch
            {
                ProductionWorkflowOutcome.Passed =>
                    $"Full identity baseline passed. Exported {Path.GetFileName(snapshot.ExportPath)}",
                ProductionWorkflowOutcome.Warning =>
                    $"Training completed and exported {Path.GetFileName(snapshot.ExportPath)}, but the baseline needs improvement.",
                _ => snapshot.Summary,
            };
        });
    }

    [RelayCommand]
    private void StartNewModelVersion()
    {
        if (IsBusy || !CanStartNewModelVersion) return;
        var confirmed = MessageBox.Show(
            "Start a new artwork model version using paper-art-v4? Previous checkpoints, indexes, reports, logs, and result ZIPs will be preserved.",
            "Start new model version",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question) == MessageBoxResult.Yes;
        if (!confirmed) return;
        try
        {
            var version = _identityProduction.StartNewModelVersion();
            RefreshProductionState();
            Status = $"Created {version}. Run the full workflow when ready.";
        }
        catch (Exception error)
        {
            Status = $"Could not start a new model version: {error.Message}";
            AppendLog(error.ToString(), null);
        }
    }

    [RelayCommand]
    private void PickCameraFolder()
    {
        var dialog = new OpenFolderDialog { Title = "Select labeled camera captures" };
        if (dialog.ShowDialog() == true)
        {
            CameraCaptureFolder = dialog.FolderName;
        }
    }

    [RelayCommand]
    private async Task PrepareCameraAsync()
    {
        if (string.IsNullOrWhiteSpace(CameraCaptureFolder))
        {
            Status = "Select a camera capture folder first.";
            return;
        }
        var output = Path.Combine(_paths.CameraRoot, CameraVersion);
        await RunPythonStageAsync(
            "Validating the camera set…",
            ["prepare-camera", "--input-root", CameraCaptureFolder, "--output-root", output,
                "--dataset-manifest", _paths.ManifestPath(DatasetVersion), "--camera-version", CameraVersion],
            $"{ModelVersion}-camera-prepare",
            () => File.Exists(Path.Combine(output, "camera-manifest.jsonl")),
            "Camera validation set is ready.");
    }

    [RelayCommand]
    private async Task EvaluateAsync()
    {
        var arguments = new List<string>
        {
            "evaluate", "--manifest", _paths.ManifestPath(DatasetVersion),
            "--checkpoint", BestCheckpointPath, "--device", "cuda", "--batch-size", "64", "--workers", "4",
        };
        var cameraManifest = Path.Combine(_paths.CameraRoot, CameraVersion, "camera-manifest.jsonl");
        if (File.Exists(cameraManifest))
        {
            arguments.AddRange(["--camera-manifest", cameraManifest]);
        }
        await RunPythonStageAsync(
            "Evaluating the model…",
            arguments,
            $"{ModelVersion}-evaluate",
            () => File.Exists(Path.Combine(_paths.ArtifactRoot(ModelVersion), "thresholds.json")),
            "Evaluation and thresholds are ready.");
    }

    [RelayCommand]
    private void PickRecognitionImage()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Select a saved card image",
            Filter = "Images|*.jpg;*.jpeg;*.png;*.webp|All files|*.*",
        };
        if (dialog.ShowDialog() == true)
        {
            RecognitionImage = dialog.FileName;
        }
    }

    [RelayCommand]
    private async Task RecognizeAsync()
    {
        if (string.IsNullOrWhiteSpace(RecognitionImage))
        {
            Status = "Select an image first.";
            return;
        }
        await RunPythonStageAsync(
            "Recognizing the saved image…",
            ["recognize", "--checkpoint", BestCheckpointPath, "--image", RecognitionImage, "--device", "cuda", "--input-kind", "auto"],
            $"{ModelVersion}-recognize",
            () => true,
            "Recognition completed; see the live log for the result.");
    }

    [RelayCommand]
    private async Task ExportResultsAsync()
    {
        await RunGuardedAsync("Creating checksummed result ZIP…", async cancellationToken =>
        {
            var path = await _exporter.ExportAsync(ModelVersion, cancellationToken);
            AppendLog($"Exported {path}", null);
            return $"Exported {Path.GetFileName(path)}";
        });
    }

    [RelayCommand] private void Cancel() => _activeCancellation?.Cancel();

    [RelayCommand]
    private void CopySelectedLog()
    {
        if (!string.IsNullOrWhiteSpace(SelectedLogLine))
        {
            Clipboard.SetText(SelectedLogLine);
        }
    }

    [RelayCommand]
    private void CopyAllLogs()
    {
        var lines = LiveLog.ToArray();
        var text = string.Join(Environment.NewLine, lines);
        if (!string.IsNullOrWhiteSpace(text))
        {
            Clipboard.SetText(text);
        }
    }

    [RelayCommand]
    private void OpenTrainingFolder()
    {
        Directory.CreateDirectory(_paths.TrainingRoot);
        Process.Start(new ProcessStartInfo(_paths.TrainingRoot) { UseShellExecute = true });
    }

    [RelayCommand]
    private void OpenLogFolder()
    {
        Directory.CreateDirectory(_paths.LogsRoot);
        Process.Start(new ProcessStartInfo(_paths.LogsRoot) { UseShellExecute = true });
    }

    [RelayCommand]
    private void ClearAllLogs()
    {
        var confirmed = MessageBox.Show(
            "Clear every line shown here and permanently empty the current Deckino application log file? Separate training-stage logs and older daily logs will be preserved.",
            "Clear activity log",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning) == MessageBoxResult.Yes;
        if (!confirmed) return;

        try
        {
            _applicationLog.ClearCurrentLog();
            LiveLog.Clear();
            SelectedLogLine = null;
            Status = "Activity log cleared.";
        }
        catch (Exception error)
        {
            Status = $"Could not clear the activity log: {error.Message}";
            MessageBox.Show(
                Status,
                "Clear activity log failed",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private async Task RunPythonStageAsync(
        string workingStatus,
        IReadOnlyList<string> commandArguments,
        string logName,
        Func<bool> completed,
        string completedStatus)
    {
        await RunGuardedAsync(workingStatus, async cancellationToken =>
        {
            if (!PackagesReady)
            {
                throw new InvalidOperationException("Check requirements and install packages first.");
            }
            await EnsurePaperCacheCompleteAsync();
            var arguments = new List<string> { "-m", "deckino_training" };
            arguments.AddRange(commandArguments);
            var result = await _runner.RunAsync(
                _paths.VirtualEnvironmentPython,
                arguments,
                logName,
                AppendLog,
                cancellationToken);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException($"Stage failed with exit code {result.ExitCode}. See {result.LogPath}");
            }
            if (!completed())
            {
                throw new InvalidOperationException("Stage exited successfully without producing its required artifact.");
            }
            return completedStatus;
        });
    }

    private async Task EnsurePaperCacheCompleteAsync()
    {
        if (await IsPaperCacheCompleteAsync()) return;
        await using var connection = _database.OpenConnection();
        var incomplete = await CountIncompletePaperImagesAsync(connection);
        throw new InvalidOperationException($"The paper image cache is incomplete ({incomplete:N0} images remaining). Finish Scryfall Sync first.");
    }

    private async Task<bool> IsPaperCacheCompleteAsync()
    {
        await using var connection = _database.OpenConnection();
        return await CountIncompletePaperImagesAsync(connection) == 0;
    }

    private static Task<long> CountIncompletePaperImagesAsync(Microsoft.Data.Sqlite.SqliteConnection connection) =>
        connection.ExecuteScalarAsync<long>(
            """
            SELECT COUNT(*)
            FROM cards c
            LEFT JOIN art_downloads d ON d.scryfall_id = c.scryfall_id
            WHERE c.is_paper = 1 AND c.oracle_id IS NOT NULL AND c.art_crop_uri IS NOT NULL
              AND (d.status IS NULL OR d.status <> 'downloaded' OR d.file_path IS NULL)
            """);

    private async Task ApplyReadinessAsync(TrainingReadiness readiness)
    {
        PaperCacheReady = await IsPaperCacheCompleteAsync();
        PackagesReady = readiness.Ready;
        EnvironmentReady = readiness.Ready && PaperCacheReady;
        _selectedProfile = readiness.GpuIndex is { } gpuIndex
            && readiness.GpuName is { } gpuName
            && readiness.VramMiB is { } vram
            ? TrainingEnvironmentService.CreateTrainingProfile(gpuIndex, gpuName, vram)
            : null;

        var gpuMatches = _selectedProfile is not null;
        var vramReady = readiness.VramMiB >= TrainingEnvironmentService.MinimumVramMiB;
        var diskState = readiness.FreeDiskGiB >= 20
            ? RequirementState.Passed
            : readiness.HasMinimumDiskSpace
                ? RequirementState.Warning
                : RequirementState.Missing;
        var checks = new[]
        {
            new RequirementCheckItem(
                "Compatible NVIDIA GPU",
                _selectedProfile is null
                    ? readiness.GpuName ?? "No NVIDIA GPU with at least 6,000 MiB VRAM was detected"
                    : $"{_selectedProfile.GpuName} · device {_selectedProfile.DeviceIndex} · {_selectedProfile.Label}",
                gpuMatches ? RequirementState.Passed : RequirementState.Missing),
            new RequirementCheckItem(
                "NVIDIA driver",
                readiness.DriverVersion is { } driver ? $"Driver {driver}" : "Driver version unavailable",
                readiness.DriverVersion is null ? RequirementState.Missing : RequirementState.Passed),
            new RequirementCheckItem(
                "GPU memory",
                readiness.VramMiB is { } memory
                    ? $"{memory:N0} MiB available · {TrainingEnvironmentService.MinimumVramMiB:N0} MiB minimum"
                    : "Memory information unavailable",
                vramReady ? RequirementState.Passed : RequirementState.Missing),
            new RequirementCheckItem(
                "Free disk space",
                $"{readiness.FreeDiskGiB:F1} GiB free · 15 GiB minimum · 20 GiB recommended",
                diskState),
            new RequirementCheckItem(
                "Python 3.12 x64",
                readiness.PythonPath ?? "Not installed — Deckino can install a private copy",
                readiness.PythonPath is null ? RequirementState.Missing : RequirementState.Passed),
            new RequirementCheckItem(
                "Deckino virtual environment",
                readiness.VirtualEnvironmentReady ? "Local runtime is present" : "Not created yet",
                readiness.VirtualEnvironmentReady ? RequirementState.Passed : RequirementState.Missing),
            new RequirementCheckItem(
                "PyTorch CUDA packages",
                readiness.PackagesReady
                    ? $"PyTorch {readiness.TorchVersion} · CUDA {readiness.CudaRuntime}"
                    : "Pinned CUDA packages are not installed",
                readiness.PackagesReady ? RequirementState.Passed : RequirementState.Missing),
            new RequirementCheckItem(
                "CUDA connection",
                readiness.CudaReady ? "PyTorch can use the selected GPU" : "Checked after the local runtime is installed",
                readiness.CudaReady
                    ? RequirementState.Passed
                    : readiness.PackagesReady ? RequirementState.Missing : RequirementState.Pending),
            new RequirementCheckItem(
                "Pretrained MobileNet weights",
                readiness.PretrainedWeightsCached ? "Cached inside Deckino data" : "Downloaded during package installation",
                readiness.PretrainedWeightsCached ? RequirementState.Passed : RequirementState.Missing),
            new RequirementCheckItem(
                "Paper image cache",
                PaperCacheReady ? "All eligible Scryfall art is available" : "Complete Scryfall Sync before preparing the dataset",
                PaperCacheReady ? RequirementState.Passed : RequirementState.Missing),
        };
        ReplaceRequirementChecks(checks);
        var passed = checks.Count(check => check.State == RequirementState.Passed);
        RequirementsHeadline = EnvironmentReady
            ? "✓ All environment requirements met"
            : "Setup required";
        RequirementsCaption = EnvironmentReady
            ? $"{_selectedProfile!.GpuName} is ready at batch {_selectedProfile.BatchSize}."
            : $"{checks.Length - passed} items need attention. Open the checklist for details.";
        RequirementsSummary = string.Join(" · ", checks.Select(check => $"{check.Name}: {check.Detail}"));
        RefreshProductionState();
        UpdateProductionGate();
    }

    private void SetPendingRequirements()
    {
        var names = new[]
        {
            "Compatible NVIDIA GPU", "NVIDIA driver", "GPU memory", "Free disk space",
            "Python 3.12 x64", "Deckino virtual environment", "PyTorch CUDA packages",
            "CUDA connection", "Pretrained MobileNet weights", "Paper image cache",
        };
        ReplaceRequirementChecks(names.Select(name =>
            new RequirementCheckItem(name, "Waiting for requirements check", RequirementState.Pending)));
    }

    private void ReplaceRequirementChecks(IEnumerable<RequirementCheckItem> checks)
    {
        RequirementChecks.Clear();
        foreach (var check in checks) RequirementChecks.Add(check);
    }

    private async Task RunGuardedAsync(
        string workingStatus,
        Func<CancellationToken, Task<string>> action,
        bool coordinate = true)
    {
        if (IsBusy) return;
        IsBusy = true;
        Status = workingStatus;
        _applicationLog.Information("operation", $"Started: {workingStatus}");
        _activeCancellation = new CancellationTokenSource();
        try
        {
            using var lease = coordinate
                ? await _coordinator.AcquireAsync("model training", _activeCancellation.Token)
                : null;
            Status = await action(_activeCancellation.Token);
            _applicationLog.Information("operation", $"Completed: {Status}");
        }
        catch (OperationCanceledException)
        {
            Status = "Cancelled.";
            _applicationLog.Information("operation", "Cancelled by the user.");
        }
        catch (Exception error)
        {
            Status = $"Failed: {error.Message}";
            AppendLog(error.ToString(), null);
        }
        finally
        {
            _activeCancellation.Dispose();
            _activeCancellation = null;
            IsBusy = false;
            RefreshStageState();
            RefreshProductionState();
        }
    }

    private void AppendLog(string line, JsonElement? parsed)
    {
        _applicationLog.Information("training", line);
        Application.Current.Dispatcher.BeginInvoke(() =>
        {
            var rendered = parsed is { } json && json.TryGetProperty("event", out var eventName)
                ? $"{DateTime.Now:HH:mm:ss} {eventName.GetString()} · {line}"
                : $"{DateTime.Now:HH:mm:ss} {line}";
            LiveLog.Add(rendered);
            while (LiveLog.Count > MaximumLogLines) LiveLog.RemoveAt(0);
            if (parsed is { } progress && progress.TryGetProperty("event", out var name))
            {
                Status = name.GetString() switch
                {
                    "prepare_progress" => $"Scanning images {progress.GetProperty("scanned").GetInt64():N0} / {progress.GetProperty("total").GetInt64():N0}…",
                    "training_progress" => $"Epoch {progress.GetProperty("epoch").GetInt32()} · batch {progress.GetProperty("batch").GetInt32()} / {progress.GetProperty("batches").GetInt32()}",
                    "recognition" => progress.GetProperty("rejected").GetBoolean()
                        ? "Recognition rejected: confidence was below threshold."
                        : $"Recognized {progress.GetProperty("card_name").GetString()} ({progress.GetProperty("oracle_id").GetString()})",
                    _ => Status,
                };
            }
        });
    }

    private string SmokeMarkerPath => Path.Combine(_paths.TrainingRoot, "cuda-smoke-v3.ok");
    private string BestCheckpointPath => Path.Combine(_paths.ArtifactRoot(ModelVersion), "best.pt");

    private void RefreshStageState()
    {
        var availability = TrainingStageAvailability.Evaluate(
            _paths, DatasetVersion, ModelVersion, PackagesReady, PaperCacheReady);
        CanPrepareDataset = availability.CanPrepareDataset;
        DatasetReady = availability.DatasetReady;
        CudaSmokeReady = availability.CudaSmokeReady;
        TrainingReady = availability.TrainingReady;
        EvaluationReady = availability.EvaluationReady;
        CanTrainProduction = availability.CudaSmokeReady;
        UpdateProductionGate();
    }

    private void RefreshProductionState()
    {
        try
        {
            ApplyProductionSnapshot(_identityProduction.Inspect());
        }
        catch (Exception error)
        {
            ProductionOutcome = ProductionWorkflowOutcome.Failed;
            ProductionSummary = error.Message;
            ProductionStages.Clear();
            ProductionExportPath = null;
            AppendLog(error.Message, null);
        }
    }

    private void ApplyProductionSnapshot(IdentityProductionSnapshot snapshot)
    {
        ProductionOutcome = snapshot.Outcome;
        ProductionSummary = snapshot.Summary;
        DatasetVersion = snapshot.DatasetVersion;
        ModelVersion = snapshot.ModelVersion;
        ProductionExportPath = snapshot.ExportPath;
        CanStartNewModelVersion = snapshot.CanStartNewVersion;
        ProductionStages.Clear();
        foreach (var stage in snapshot.Stages) ProductionStages.Add(stage);
        var gpu = snapshot.GpuName ?? _selectedProfile?.GpuName ?? "Selected during requirements check";
        var profile = snapshot.GpuProfile ?? _selectedProfile?.Label ?? "Adaptive 6 GB / 8 GB profile";
        var batch = snapshot.BatchSize ?? _selectedProfile?.BatchSize;
        ProductionRunDetails =
            $"{snapshot.DatasetVersion} · {snapshot.ModelVersion}\n"
            + $"{gpu} · {profile} · batch {(batch?.ToString() ?? "adaptive")}\n"
            + $"CUDA · AMP · {IdentityProductionWorkflowService.Epochs} epochs · "
            + $"{IdentityProductionWorkflowService.Workers} workers · "
            + $"{IdentityProductionWorkflowService.EmbeddingDimension}d · "
            + $"{IdentityProductionWorkflowService.LearningRate} · seed {IdentityProductionWorkflowService.Seed}"
            + (snapshot.ExportPath is null ? string.Empty : $"\nOutput: {snapshot.ExportPath}");
        UpdateProductionGate();
    }

    private void UpdateProductionGate()
    {
        CanRunProduction = !IsBusy && EnvironmentReady && _selectedProfile is not null;
        CanInstallPackages = !IsBusy && !PackagesReady;
        ProductionActionHint = CanRunProduction
            ? string.Empty
            : IsBusy
                ? "A workspace operation is currently running."
                : !EnvironmentReady
                    ? "Complete Environment Readiness before starting artwork qualification."
                    : "Check requirements again to select a compatible NVIDIA GPU.";
        CanStartNewModelVersion = CanStartNewModelVersion && !IsBusy;
    }

    private void UpdatePrepareGate() => RefreshStageState();
}
