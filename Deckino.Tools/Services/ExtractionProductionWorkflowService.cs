using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Deckino.Tools.Services;

public sealed record ExtractionWorkflowSnapshot(
    ProductionWorkflowOutcome Outcome,
    string Summary,
    string DatasetVersion,
    string ModelVersion,
    IReadOnlyList<ProductionStageResult> Stages,
    string? GpuName = null,
    string? GpuProfile = null,
    int? BatchSize = null,
    int CompletedEpoch = 0,
    string? ExportPath = null,
    bool IncludeSyntheticCards = false);

public sealed class ExtractionProductionWorkflowService(
    TrainingPaths paths,
    PythonProcessRunner runner,
    TrainingResultExporter exporter)
{
    public const string DatasetVersion = "corners-v1";
    public const string InitialModelVersion = "extractor-mnv3-spatial-256-recipe3";
    public const int Seed = 20260824;
    public const int Epochs = 150;
    public const int Workers = 4;
    private const int StateSchemaVersion = 2;
    private const int TrainingRecipeVersion = 3;

    private static readonly (string Id, string Name)[] StageDefinitions =
    [
        ("inputs", "Inspect annotations & full-card assets"),
        ("dataset", "Prepare grouped extraction dataset"),
        ("cuda", "GPU profile & extractor CUDA smoke"),
        ("quick", "Real-photo learning check"),
        ("train", "Train or resume full extractor"),
        ("evaluate", "Evaluate & calibrate geometry"),
        ("diagnostics", "Extraction & rectification diagnostics"),
        ("export", "Export extraction result ZIP"),
        ("verify", "Verify SHA-256 checksums"),
    ];

    public string ActiveModelPath => Path.Combine(paths.ExtractionProductionRoot, "active-extraction-model.txt");
    public string ActiveModelVersion => ReadActiveModelVersion();

    public ExtractionWorkflowSnapshot Inspect()
    {
        var modelVersion = ReadActiveModelVersion();
        var state = LoadState(modelVersion);
        if (state is null) return EmptySnapshot(modelVersion, "Ready to prepare the card extractor.");
        if (state.SchemaVersion != StateSchemaVersion || state.TrainingRecipeVersion != TrainingRecipeVersion)
            return EmptySnapshot(modelVersion, "Ready for recipe 3: balanced training and precision finishing; previous checkpoints are retained.");
        ValidateIdentity(state, modelVersion);
        ValidateCompletedArtifacts(state);
        return ToSnapshot(state);
    }

    public Task<ExtractionWorkflowSnapshot> RunAsync(
        CudaTrainingProfile profile,
        Action<string, JsonElement?> onLine,
        Action<ExtractionWorkflowSnapshot>? onProgress,
        CancellationToken cancellationToken,
        bool includeSyntheticCards = false) =>
        RunCoreAsync(profile, onLine, onProgress, cancellationToken, includeSyntheticCards);

    public async Task<string> RunDiagnosticAsync(
        string imagePath,
        CudaTrainingProfile profile,
        Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var modelVersion = ActiveModelVersion;
        var artifactRoot = paths.ArtifactRoot(modelVersion);
        var selectedImage = Path.GetFullPath(imagePath);
        EnsureFile(selectedImage, "selected diagnostic image");
        if (!new[] { ".jpg", ".jpeg", ".png" }.Contains(
                Path.GetExtension(selectedImage), StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException("Choose a JPG, JPEG, or PNG photograph for extraction testing.");
        EnsureFile(Path.Combine(artifactRoot, "best.pt"), "best extraction checkpoint");
        EnsureFile(Path.Combine(artifactRoot, "thresholds.json"), "extraction thresholds");
        var output = CreateManualDiagnosticOutputPath(artifactRoot);
        await RunCliAsync([
            "rectify-extraction", "--checkpoint", Path.Combine(artifactRoot, "best.pt"),
            "--thresholds", Path.Combine(artifactRoot, "thresholds.json"),
            "--image", selectedImage, "--output-root", output,
            "--device", "cuda", "--cuda-device-index", profile.DeviceIndex.ToString(),
        ], $"{modelVersion}-manual-diagnostic", onLine, cancellationToken);
        return output;
    }

    internal static string CreateManualDiagnosticOutputPath(string artifactRoot) => Path.Combine(
        artifactRoot,
        "diagnostics",
        "manual",
        $"{DateTime.UtcNow:yyyyMMdd-HHmmssfff}-{Guid.NewGuid():N}");

    private async Task<ExtractionWorkflowSnapshot> RunCoreAsync(
        CudaTrainingProfile profile,
        Action<string, JsonElement?> onLine,
        Action<ExtractionWorkflowSnapshot>? onProgress,
        CancellationToken cancellationToken,
        bool includeSyntheticCards)
    {
        Directory.CreateDirectory(paths.ExtractionProductionRoot);
        var state = SelectRunForExecution(includeSyntheticCards);
        var modelVersion = state.ModelVersion;
        ValidateIdentity(state, modelVersion);
        ValidateCompletedArtifacts(state);

        var gpuChanged = state.GpuName is not null
            && (!state.GpuName.Equals(profile.GpuName, StringComparison.OrdinalIgnoreCase)
                || state.GpuIndex != profile.DeviceIndex);
        if (gpuChanged)
            SetStage(state, "cuda", ProductionStageStatus.Pending, "GPU changed; extractor CUDA validation will run again.");
        state.GpuName = profile.GpuName;
        state.GpuIndex = profile.DeviceIndex;
        state.GpuProfile = profile.Label;
        state.VramMiB = profile.VramMiB;
        if (gpuChanged || state.BatchSize == 0) state.BatchSize = profile.BatchSize;
        SaveState(state);
        onLine(state.IncludeSyntheticCards
            ? "Training inputs: annotated imports plus synthetic scenes."
            : "Training inputs: annotated imports only; synthetic scenes are excluded.", null);

        async Task ExecuteAsync(string id, string detail, Func<Task<StageCompletion>> action)
        {
            if (IsComplete(state, id)) return;
            SetStage(state, id, ProductionStageStatus.Running, detail);
            SaveState(state); onProgress?.Invoke(ToSnapshot(state));
            try
            {
                var completion = await action();
                SetStage(state, id, completion.Status, completion.Detail);
                SaveState(state); onProgress?.Invoke(ToSnapshot(state));
            }
            catch (OperationCanceledException)
            {
                SetStage(state, id, ProductionStageStatus.Cancelled,
                    "Cancelled safely; completed stages and checkpoints are retained.");
                SaveState(state); onProgress?.Invoke(ToSnapshot(state));
                throw;
            }
            catch
            {
                SetStage(state, id, ProductionStageStatus.Failed,
                    "Stage failed. Review the activity log, then run again to retry.");
                SaveState(state); onProgress?.Invoke(ToSnapshot(state));
                throw;
            }
        }

        await ExecuteAsync("inputs", "Inspecting managed sidecars and extraction assets…", () =>
        {
            var sidecars = Directory.Exists(paths.CameraImportsRoot)
                ? Directory.EnumerateFiles(paths.CameraImportsRoot, "*._annotations.json", SearchOption.AllDirectories).Count()
                : 0;
            if (sidecars == 0) throw new InvalidOperationException("No managed Corner Annotator sidecars were found.");
            if (!state.IncludeSyntheticCards)
                return Task.FromResult(StageCompletion.Passed(
                    $"Found {sidecars:N0} annotations. Synthetic cards are disabled; full-card assets are not required."));
            var fullCards = Directory.Exists(paths.ExtractionFullCardsRoot)
                ? Directory.EnumerateFiles(paths.ExtractionFullCardsRoot, "*", SearchOption.AllDirectories)
                    .Count(path => Path.GetExtension(path).ToLowerInvariant() is ".jpg" or ".jpeg" or ".png")
                : 0;
            return Task.FromResult(fullCards > 0
                ? StageCompletion.Passed($"Found {sidecars:N0} annotations and {fullCards:N0} full-card assets.")
                : StageCompletion.Warning($"Found {sidecars:N0} annotations; no full-card assets are cached, so synthetic coverage is unavailable."));
        });

        await ExecuteAsync("dataset", "Reading the latest annotated photos and building this run's snapshot…", async () =>
        {
            var arguments = new List<string>
            {
                "prepare-extraction", "--data-root", paths.DataRoot, "--dataset-version", state.DatasetVersion,
                "--seed", Seed.ToString(), "--synthetic-per-card", "4", "--max-full-cards", "5000",
            };
            if (state.IncludeSyntheticCards) arguments.Add("--include-synthetic");
            var result = await RunCliAsync(arguments, $"{modelVersion}-prepare-extraction", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            EnsureFile(paths.ManifestPath(state.DatasetVersion), "extraction manifest");
            var report = ReadJson(Path.Combine(paths.DatasetRoot(state.DatasetVersion), "preparation-report.json"));
            state.DatasetReady = report.GetProperty("production_data_ready").GetBoolean();
            var records = report.GetProperty("records").GetInt32();
            var real = report.GetProperty("real_records").GetInt32();
            var synthetic = report.GetProperty("synthetic_records").GetInt32();
            var composition = $"{records:N0} samples ({real:N0} real, {synthetic:N0} synthetic)";
            return state.DatasetReady
                ? StageCompletion.Passed($"Prepared and checksummed {composition}.")
                : StageCompletion.Warning($"Prepared {composition}; production split/negative coverage remains incomplete.");
        });

        await ExecuteAsync("cuda", $"Testing {profile.GpuName} at batch {state.BatchSize}…", async () =>
        {
            var result = await RunCudaSmokeAsync(state, profile, onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            return StageCompletion.Passed($"Extractor CUDA smoke passed at batch {state.BatchSize}.");
        });

        await ExecuteAsync("quick", "Checking real-photo learning and saved-checkpoint inference…", async () =>
        {
            var quickVersion = modelVersion + "-learning";
            var result = await RunCliAsync([
                "extraction-learning-check", "--manifest", paths.ManifestPath(state.DatasetVersion),
                "--artifacts-root", paths.ArtifactsRoot, "--model-version", quickVersion,
                "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
                "--batch-size", state.BatchSize.ToString(), "--workers", Workers.ToString(),
                "--seed", Seed.ToString(),
            ], $"{modelVersion}-learning-check", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            var reportPath = Path.Combine(paths.ArtifactRoot(quickVersion), "learning-check.json");
            var report = ReadJson(reportPath);
            if (!report.GetProperty("passed").GetBoolean())
                throw new InvalidOperationException("Real-photo learning check failed. Inspect its loss history and failure previews.");
            File.Copy(reportPath, Path.Combine(paths.ArtifactRoot(modelVersion), "learning-check.json"), overwrite: true);
            return StageCompletion.Passed("Real-photo corner learning and checkpoint reload parity passed; full training starts from fresh weights.");
        });

        var artifactRoot = paths.ArtifactRoot(modelVersion);
        await ExecuteAsync("train", $"Training the full extractor through at most epoch {Epochs}…", async () =>
        {
            var last = Path.Combine(artifactRoot, "last.pt");
            var arguments = new List<string>
            {
                "train-extraction", "--manifest", paths.ManifestPath(state.DatasetVersion),
                "--artifacts-root", paths.ArtifactsRoot, "--model-version", modelVersion,
                "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
                "--batch-size", state.BatchSize.ToString(), "--epochs", Epochs.ToString(),
                "--workers", Workers.ToString(), "--learning-rate", "3e-4", "--seed", Seed.ToString(),
                "--pretrained", "--patience", "20",
            };
            if (File.Exists(last)) arguments.AddRange(["--resume", last]);
            var result = await RunCliAsync(arguments, $"{modelVersion}-train", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            EnsureFile(Path.Combine(artifactRoot, "best.pt"), "best extraction checkpoint");
            EnsureFile(last, "last extraction checkpoint");
            state.CompletedEpoch = LastEpoch(result) ?? Epochs;
            return StageCompletion.Passed($"Full extraction training completed through epoch {state.CompletedEpoch}.");
        });

        await ExecuteAsync("evaluate", "Calibrating presence and evaluating locked geometry groups…", async () =>
        {
            var arguments = new List<string>
            {
                "evaluate-extraction", "--manifest", paths.ManifestPath(state.DatasetVersion),
                "--checkpoint", Path.Combine(artifactRoot, "best.pt"), "--output-root", artifactRoot,
                "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
                "--batch-size", state.BatchSize.ToString(), "--workers", Workers.ToString(),
            };
            if (state.BaselineModelVersion is not null)
            {
                var baseline = Path.Combine(paths.ArtifactRoot(state.BaselineModelVersion), "best.pt");
                if (File.Exists(baseline)) arguments.AddRange(["--baseline-checkpoint", baseline]);
            }
            var result = await RunCliAsync(arguments, $"{modelVersion}-evaluate", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            state.Evaluation = ReadJson(Path.Combine(artifactRoot, "evaluation.json"));
            state.Qualified = state.Evaluation.Value.GetProperty("qualified").GetBoolean();
            return state.Qualified
                ? StageCompletion.Passed("All extraction geometry and real-camera qualification gates passed.")
                : StageCompletion.Warning("Evaluation completed; quality or real-camera coverage remains below qualification.");
        });

        await ExecuteAsync("diagnostics", "Writing predicted corners, warp, and identity-crop preview…", async () =>
        {
            var sample = ReadKnownSample(state.DatasetVersion);
            var diagnosticRoot = Path.Combine(artifactRoot, "diagnostics");
            var result = await RunCliAsync([
                "rectify-extraction", "--checkpoint", Path.Combine(artifactRoot, "best.pt"),
                "--thresholds", Path.Combine(artifactRoot, "thresholds.json"),
                "--image", sample, "--output-root", diagnosticRoot,
                "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
            ], $"{modelVersion}-diagnostics", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            EnsureFile(Path.Combine(diagnosticRoot, "diagnostic.json"), "extraction diagnostic");
            var diagnostic = ReadJson(Path.Combine(diagnosticRoot, "diagnostic.json"));
            return diagnostic.GetProperty("accepted").GetBoolean()
                ? StageCompletion.Passed("Produced predicted corners, a 315×440 warp, and recognition-crop preview.")
                : StageCompletion.Warning("Diagnostic image was safely rejected; review its overlay and confidence.");
        });

        string? provisionalZip = null;
        await ExecuteAsync("export", "Creating the checksummed extraction bundle…", async () =>
        {
            WriteReport(state, completed: false);
            provisionalZip = await exporter.ExportExtractionAsync(modelVersion, cancellationToken);
            state.ExportPath = provisionalZip;
            return StageCompletion.Passed($"Created {Path.GetFileName(provisionalZip)}.");
        });
        await ExecuteAsync("verify", "Reopening the ZIP and hashing every entry…", async () =>
        {
            var verified = await exporter.VerifyExtractionAsync(
                state.ExportPath ?? throw Inconsistent("Extraction export path is missing."), cancellationToken);
            return StageCompletion.Passed($"Verified all {verified.VerifiedEntries} checksummed entries.");
        });

        state.Completed = true;
        state.CompletedUtc = DateTime.UtcNow;
        WriteReport(state, completed: true);
        SaveState(state);
        var finalZip = await exporter.ExportExtractionAsync(modelVersion, cancellationToken);
        await exporter.VerifyExtractionAsync(finalZip, cancellationToken);
        state.ExportPath = finalZip;
        SaveState(state);
        if (provisionalZip is not null && !provisionalZip.Equals(finalZip, StringComparison.OrdinalIgnoreCase)
            && File.Exists(provisionalZip)) File.Delete(provisionalZip);
        return ToSnapshot(state);
    }

    public static int NextLowerBatch(int currentBatch) => Math.Max(16, currentBatch / 2);

    private async Task<PythonRunResult> RunCudaSmokeAsync(
        ExtractionState state, CudaTrainingProfile profile, Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var command = new List<string> { "extraction-smoke", "--manifest", paths.ManifestPath(state.DatasetVersion),
            "--device", "cuda", "--cuda-device-index", profile.DeviceIndex.ToString(),
            "--batch-size", state.BatchSize.ToString(), "--steps", "2" };
        var result = await RunCliRawAsync(command, $"{state.ModelVersion}-extractor-smoke-{state.BatchSize}", onLine, cancellationToken);
        if (result.ExitCode != 0 && IsOutOfMemory(result))
        {
            state.BatchSize = NextLowerBatch(state.BatchSize); SaveState(state);
            command[^3] = state.BatchSize.ToString();
            result = await RunCliRawAsync(command, $"{state.ModelVersion}-extractor-smoke-{state.BatchSize}", onLine, cancellationToken);
        }
        EnsureSuccess(result);
        return result;
    }

    private async Task<PythonRunResult> RunCliAsync(
        IReadOnlyList<string> command, string logName, Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var result = await RunCliRawAsync(command, logName, onLine, cancellationToken);
        EnsureSuccess(result); return result;
    }

    private Task<PythonRunResult> RunCliRawAsync(
        IReadOnlyList<string> command, string logName, Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var arguments = new List<string> { "-m", "deckino_training" }; arguments.AddRange(command);
        return runner.RunAsync(paths.VirtualEnvironmentPython, arguments, logName, onLine, cancellationToken);
    }

    private static void EnsureSuccess(PythonRunResult result)
    {
        if (result.ExitCode != 0)
            throw new InvalidOperationException($"Stage failed with exit code {result.ExitCode}. See {result.LogPath}");
    }

    private static bool IsOutOfMemory(PythonRunResult result) => result.Events.Any(element =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty("error_code", out var code)
        && code.GetString() == "cuda_out_of_memory");

    private string ReadKnownSample(string datasetVersion)
    {
        foreach (var line in File.ReadLines(paths.ManifestPath(datasetVersion)))
        {
            using var document = JsonDocument.Parse(line);
            if (!document.RootElement.GetProperty("card_present").GetBoolean()) continue;
            var relative = document.RootElement.GetProperty("image_path").GetString()
                ?? throw Inconsistent("Extraction manifest sample path is empty.");
            return EnsureContained(Path.Combine(paths.DataRoot, relative.Replace('/', Path.DirectorySeparatorChar)), paths.DataRoot);
        }
        throw Inconsistent("Extraction manifest has no positive diagnostic sample.");
    }

    private void WriteReport(ExtractionState state, bool completed)
    {
        Directory.CreateDirectory(paths.ArtifactRoot(state.ModelVersion));
        AtomicWrite(Path.Combine(paths.ArtifactRoot(state.ModelVersion), "extraction-report.json"), new
        {
            extraction_report_schema_version = 2, artifact_schema_version = 2,
            dataset_version = state.DatasetVersion, model_version = state.ModelVersion,
            include_synthetic_cards = state.IncludeSyntheticCards,
            architecture = "mobilenetv3-small-spatial-v2", training_recipe_version = TrainingRecipeVersion,
            independent_from_identity = true, input_size = 256, heatmap_size = 64,
            corner_order = new[] { "TopLeft", "TopRight", "BottomRight", "BottomLeft" },
            coordinate_contract = "EXIF-normalized image; x/(width-1), y/(height-1); printed orientation",
            rectified_output = new { width = 315, height = 440 },
            recognition_crop_v1 = new { left = 0.08, top = 0.11, right = 0.92, bottom = 0.49,
                canonical_pixels = new { left = 25, top = 48, right = 290, bottom = 216 },
                inspection_resize = new { width = 224, height = 224, resampling = "bicubic" },
                production_identity_contract_changed = false },
            gpu_profile = new { device_index = state.GpuIndex, name = state.GpuName,
                vram_mib = state.VramMiB, profile = state.GpuProfile, effective_batch_size = state.BatchSize },
            stages = StageDefinitions.Select(definition => state.Stages[definition.Id]),
            completed_epoch = state.CompletedEpoch, evaluation = state.Evaluation,
            baseline_trained = state.CompletedEpoch > 0, extraction_qualified = state.Qualified,
            phase_completion = new { engineering_complete = completed,
                baseline_trained = state.CompletedEpoch > 0 && state.Evaluation is not null,
                extraction_qualified = state.Qualified },
            mobile_export_performed = false, identity_inference_performed = false,
            started_utc = state.StartedUtc, completed_utc = completed ? state.CompletedUtc : null,
            logs = state.Logs.Select(Path.GetFileName).Distinct(StringComparer.Ordinal).OrderBy(name => name),
        });
    }

    private void ValidateCompletedArtifacts(ExtractionState state)
    {
        if (IsComplete(state, "dataset")) EnsureFile(paths.ManifestPath(state.DatasetVersion), "extraction manifest");
        var root = paths.ArtifactRoot(state.ModelVersion);
        if (IsComplete(state, "quick"))
        {
            var learningReport = Path.Combine(root, "learning-check.json");
            EnsureFile(learningReport, "real-photo learning check");
            if (!ReadJson(learningReport).GetProperty("passed").GetBoolean())
                throw Inconsistent("Recorded real-photo learning check did not pass.");
        }
        if (IsComplete(state, "train")) { EnsureFile(Path.Combine(root, "best.pt"), "best extraction checkpoint"); EnsureFile(Path.Combine(root, "last.pt"), "last extraction checkpoint"); }
        if (IsComplete(state, "evaluate")) { EnsureFile(Path.Combine(root, "evaluation.json"), "extraction evaluation"); EnsureFile(Path.Combine(root, "extractor.pt"), "compact extractor"); }
        if (IsComplete(state, "export") && (state.ExportPath is null || !File.Exists(state.ExportPath)))
            throw Inconsistent("Recorded extraction result ZIP is missing.");
    }

    private ExtractionState SelectRunForExecution(bool includeSyntheticCards)
    {
        Directory.CreateDirectory(paths.ExtractionProductionRoot);
        var activeVersion = ReadActiveModelVersion();
        var current = LoadState(activeVersion);
        return current is not null && !current.Completed && current.IncludeSyntheticCards == includeSyntheticCards
            && current.SchemaVersion == StateSchemaVersion && current.TrainingRecipeVersion == TrainingRecipeVersion
            ? current : CreateFreshRun(includeSyntheticCards);
    }

    private ExtractionState CreateFreshRun(bool includeSyntheticCards)
    {
        Directory.CreateDirectory(paths.ExtractionProductionRoot);
        for (var attempt = 0; attempt < 10; attempt++)
        {
            var stamp = DateTime.UtcNow.AddMilliseconds(attempt).ToString("yyyyMMddTHHmmssfffZ");
            var modelVersion = $"extractor-run-{stamp}";
            if (Directory.Exists(paths.ArtifactRoot(modelVersion)) || File.Exists(StatePath(modelVersion))) continue;
            ResetWorkingDataset();
            var state = NewState(modelVersion, "corners-current", includeSyntheticCards);
            var previous = ReadActiveModelVersion();
            state.BaselineModelVersion = FindCompletedBaseline(previous);
            AtomicWriteText(ActiveModelPath, modelVersion + Environment.NewLine);
            SaveState(state);
            return state;
        }
        throw new InvalidOperationException("Could not allocate a fresh card-extraction training run. Try again.");
    }

    private string? FindCompletedBaseline(string? version)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (!string.IsNullOrWhiteSpace(version) && Path.GetFileName(version) == version && visited.Add(version))
        {
            var root = paths.ArtifactRoot(version);
            if (File.Exists(Path.Combine(root, "best.pt")) && File.Exists(Path.Combine(root, "evaluation.json")))
                return version;
            version = LoadState(version)?.BaselineModelVersion;
        }
        return null;
    }

    private void ResetWorkingDataset()
    {
        var targets = new[]
        {
            (Path: paths.DatasetRoot("corners-current"), Root: paths.ExportsRoot),
            (Path: Path.Combine(paths.ExtractionRoot, "synthetic", "corners-current"), Root: paths.ExtractionRoot),
        };
        foreach (var target in targets)
        {
            EnsureContained(target.Path, target.Root);
            if (Directory.Exists(target.Path)) Directory.Delete(target.Path, recursive: true);
        }
    }

    private string ReadActiveModelVersion()
    {
        if (!File.Exists(ActiveModelPath)) return InitialModelVersion;
        var value = File.ReadAllText(ActiveModelPath).Trim();
        if (string.IsNullOrWhiteSpace(value) || value.Any(character => !(char.IsLetterOrDigit(character) || character is '-' or '_')))
            throw Inconsistent("The active extraction model pointer is invalid.");
        return value;
    }

    private string StatePath(string modelVersion) => Path.Combine(paths.ExtractionProductionRoot, $"{modelVersion}-state.json");
    private ExtractionState? LoadState(string modelVersion)
    {
        var path = StatePath(modelVersion); if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<ExtractionState>(File.ReadAllText(path), JsonOptions) ?? throw Inconsistent("Extraction state is empty."); }
        catch (JsonException error) { throw Inconsistent($"Extraction state is unreadable: {error.Message}"); }
    }

    private static ExtractionState NewState(string modelVersion, string datasetVersion, bool includeSyntheticCards) => new()
    {
        DatasetVersion = datasetVersion,
        ModelVersion = modelVersion,
        IncludeSyntheticCards = includeSyntheticCards,
        SchemaVersion = StateSchemaVersion,
        TrainingRecipeVersion = TrainingRecipeVersion,
        Stages = StageDefinitions.ToDictionary(definition => definition.Id,
            definition => new PersistedStage(definition.Id, definition.Name, ProductionStageStatus.Pending, "Waiting."), StringComparer.Ordinal),
    };
    private static void ValidateIdentity(ExtractionState state, string modelVersion)
    {
        if (state.SchemaVersion != StateSchemaVersion || state.TrainingRecipeVersion != TrainingRecipeVersion
            || string.IsNullOrWhiteSpace(state.DatasetVersion)
            || state.ModelVersion != modelVersion || state.Seed != Seed)
            throw Inconsistent("Existing extraction production state belongs to a different workflow.");
    }
    private void SaveState(ExtractionState state)
    {
        AtomicWrite(StatePath(state.ModelVersion), state);
        Directory.CreateDirectory(paths.ArtifactRoot(state.ModelVersion));
        AtomicWrite(Path.Combine(paths.ArtifactRoot(state.ModelVersion), "workflow-state.json"), state);
    }
    private static void SetStage(ExtractionState state, string id, ProductionStageStatus status, string detail) =>
        state.Stages[id] = state.Stages[id] with { Status = status, Detail = detail };
    private static bool IsComplete(ExtractionState state, string id) => state.Stages.TryGetValue(id, out var stage)
        && stage.Status is ProductionStageStatus.Passed or ProductionStageStatus.Warning;

    private static ExtractionWorkflowSnapshot ToSnapshot(ExtractionState state)
    {
        var outcome = state.Completed ? state.Qualified ? ProductionWorkflowOutcome.Passed : ProductionWorkflowOutcome.Warning
            : state.Stages.Values.Any(stage => stage.Status == ProductionStageStatus.Failed) ? ProductionWorkflowOutcome.Failed
            : state.Stages.Values.Any(stage => stage.Status == ProductionStageStatus.Running) ? ProductionWorkflowOutcome.Running
            : ProductionWorkflowOutcome.Ready;
        var summary = outcome switch
        {
            ProductionWorkflowOutcome.Passed => "✓ Card extraction qualified",
            ProductionWorkflowOutcome.Warning => "Artifacts exported · real-camera extraction is not yet qualified",
            ProductionWorkflowOutcome.Failed => "Extraction workflow stopped · review the activity log",
            ProductionWorkflowOutcome.Running => "Card extraction workflow in progress",
            _ => "Ready to run or resume card extraction",
        };
        return new(outcome, summary, state.DatasetVersion, state.ModelVersion,
            StageDefinitions.Select(definition => state.Stages.TryGetValue(definition.Id, out var stage)
                ? new ProductionStageResult(stage.Id, stage.Name, stage.Status, stage.Detail)
                : new ProductionStageResult(definition.Id, definition.Name, ProductionStageStatus.Pending, "Waiting.")).ToArray(),
            state.GpuName, state.GpuProfile, state.BatchSize, state.CompletedEpoch, state.ExportPath,
            state.IncludeSyntheticCards);
    }

    private static ExtractionWorkflowSnapshot EmptySnapshot(string modelVersion, string summary) => new(
        ProductionWorkflowOutcome.Ready, summary, DatasetVersion, modelVersion,
        StageDefinitions.Select(definition => new ProductionStageResult(definition.Id, definition.Name,
            ProductionStageStatus.Pending, "Waiting.")).ToArray());
    private static int? LastEpoch(PythonRunResult result)
    {
        var completed = result.Events.LastOrDefault(element => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty("event", out var name) && name.GetString() == "extraction_training_completed");
        if (completed.ValueKind == JsonValueKind.Object) return completed.GetProperty("completed_epoch").GetInt32();
        var value = result.Events.LastOrDefault(element => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty("event", out var name) && name.GetString() == "extraction_epoch_completed");
        return value.ValueKind == JsonValueKind.Object ? value.GetProperty("epoch").GetInt32() : null;
    }
    private static JsonElement ReadJson(string path) { using var document = JsonDocument.Parse(File.ReadAllText(path)); return document.RootElement.Clone(); }
    private static void EnsureFile(string path, string description) { if (!File.Exists(path)) throw Inconsistent($"Completed {description} is missing: {path}"); }
    private static string EnsureContained(string target, string root)
    {
        var full = Path.GetFullPath(target); var allowed = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) throw Inconsistent("Extraction path escapes the data root.");
        return full;
    }
    private static InvalidOperationException Inconsistent(string detail) => new($"Extraction workflow state is inconsistent. {detail}");
    private static void AtomicWrite<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!); var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, JsonOptions), new UTF8Encoding(false)); File.Move(temporary, path, true);
    }
    private static void AtomicWriteText(string path, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!); var temporary = path + ".tmp";
        File.WriteAllText(temporary, value, new UTF8Encoding(false)); File.Move(temporary, path, true);
    }
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private sealed record StageCompletion(ProductionStageStatus Status, string Detail)
    {
        public static StageCompletion Passed(string detail) => new(ProductionStageStatus.Passed, detail);
        public static StageCompletion Warning(string detail) => new(ProductionStageStatus.Warning, detail);
    }
    private sealed class ExtractionState
    {
        public int SchemaVersion { get; set; } = 1;
        public int TrainingRecipeVersion { get; set; } = 1;
        public string? BaselineModelVersion { get; set; }
        public string DatasetVersion { get; set; } = ExtractionProductionWorkflowService.DatasetVersion;
        public string ModelVersion { get; set; } = string.Empty;
        public int Seed { get; set; } = ExtractionProductionWorkflowService.Seed;
        public DateTime StartedUtc { get; set; } = DateTime.UtcNow;
        public DateTime? CompletedUtc { get; set; }
        public bool Completed { get; set; }
        // Runs saved before this option existed always included synthetic scenes.
        public bool IncludeSyntheticCards { get; set; } = true;
        public bool Qualified { get; set; }
        public bool DatasetReady { get; set; }
        public string? GpuName { get; set; }
        public int GpuIndex { get; set; }
        public long VramMiB { get; set; }
        public string? GpuProfile { get; set; }
        public int BatchSize { get; set; }
        public int CompletedEpoch { get; set; }
        public Dictionary<string, PersistedStage> Stages { get; set; } = new(StringComparer.Ordinal);
        public List<string> Logs { get; set; } = [];
        public JsonElement? Evaluation { get; set; }
        public string? ExportPath { get; set; }
    }
    private sealed record PersistedStage(string Id, string Name, ProductionStageStatus Status, string Detail);
}
