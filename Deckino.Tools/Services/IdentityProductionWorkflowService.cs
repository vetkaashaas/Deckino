using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Deckino.Tools.Services;

public enum ProductionStageStatus { Pending, Running, Passed, Warning, Failed, Cancelled }
public enum ProductionWorkflowOutcome { Ready, Running, Passed, Warning, Failed }

public sealed record ProductionStageResult(string Id, string Name, ProductionStageStatus Status, string Detail);
public sealed record IdentityProductionSnapshot(
    ProductionWorkflowOutcome Outcome,
    string Summary,
    string DatasetVersion,
    string ModelVersion,
    IReadOnlyList<ProductionStageResult> Stages,
    string? GpuName = null,
    string? GpuProfile = null,
    int? BatchSize = null,
    int CompletedEpoch = 0,
    string? SelectedCheckpoint = null,
    string? ExportPath = null,
    bool CanStartNewVersion = false);

public sealed class IdentityProductionWorkflowService(
    TrainingPaths paths,
    PythonProcessRunner runner,
    TrainingResultExporter exporter)
{
    public const string DatasetVersion = "paper-art-v4";
    public const string InitialModelVersion = "mobilenetv3s-512-art-v4";
    public const string ExistingModelVersion = "mobilenetv3s-512-v3";
    public const int Seed = 20260823;
    public const int Epochs = 30;
    public const int Workers = 4;
    public const int EmbeddingDimension = 512;
    public const string LearningRate = "3e-4";
    private const int StateSchemaVersion = 2;

    private static readonly (string Id, string Name)[] StageDefinitions =
    [
        ("dataset", "Build artwork catalog"),
        ("cuda", "GPU profile & CUDA smoke"),
        ("evidence_index", "Index a prior model if available"),
        ("evidence_evaluate", "Measure prior retrieval quality"),
        ("train", "Retrain only if required"),
        ("final_index", "Build & qualify final index"),
        ("recognize", "Recognition diagnostics"),
        ("export", "Export result ZIP"),
        ("verify", "Verify SHA-256 checksums"),
    ];

    public string ActiveModelPath => Path.Combine(paths.ProductionRoot, "active-artwork-model.txt");
    public string ActiveModelVersion => ReadActiveModelVersion();

    public IdentityProductionSnapshot Inspect()
    {
        var modelVersion = ReadActiveModelVersion();
        var state = LoadState(modelVersion);
        if (state is null)
            return EmptySnapshot(modelVersion, "Ready to measure artwork-prototype retrieval.");
        ValidateIdentity(state, modelVersion);
        ValidateCompletedArtifacts(state);
        return ToSnapshot(state);
    }

    public async Task<IdentityProductionSnapshot> RunAsync(
        CudaTrainingProfile profile,
        Action<string, JsonElement?> onLine,
        Action<IdentityProductionSnapshot>? onProgress,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(paths.ProductionRoot);
        var modelVersion = EnsureActiveModelVersion();
        var state = LoadState(modelVersion) ?? NewState(modelVersion);
        ValidateIdentity(state, modelVersion);
        ValidateCompletedArtifacts(state);
        if (state.Completed)
        {
            await exporter.VerifyIdentityAsync(
                state.ExportPath ?? throw Inconsistent("Production export path is missing."), cancellationToken);
            return ToSnapshot(state);
        }

        var gpuChanged = state.GpuName is not null
            && (!state.GpuName.Equals(profile.GpuName, StringComparison.OrdinalIgnoreCase)
                || state.GpuIndex != profile.DeviceIndex);
        if (gpuChanged)
            SetStage(state, "cuda", ProductionStageStatus.Pending, "GPU changed; CUDA validation will run again.");
        state.GpuName = profile.GpuName;
        state.GpuIndex = profile.DeviceIndex;
        state.GpuProfile = profile.Label;
        state.VramMiB = profile.VramMiB;
        if (gpuChanged || state.BatchSize == 0) state.BatchSize = profile.BatchSize;
        SaveState(state);

        async Task ExecuteAsync(string id, string detail, Func<Task<StageCompletion>> action)
        {
            if (IsComplete(state, id)) return;
            SetStage(state, id, ProductionStageStatus.Running, detail);
            SaveState(state);
            onProgress?.Invoke(ToSnapshot(state));
            try
            {
                var completion = await action();
                SetStage(state, id, completion.Status, completion.Detail);
                SaveState(state);
                onProgress?.Invoke(ToSnapshot(state));
            }
            catch (OperationCanceledException)
            {
                SetStage(state, id, ProductionStageStatus.Cancelled,
                    "Cancelled safely; completed artifacts are retained for resume.");
                SaveState(state);
                onProgress?.Invoke(ToSnapshot(state));
                throw;
            }
            catch
            {
                SetStage(state, id, ProductionStageStatus.Failed,
                    "Stage failed. Review the activity log, then run again to retry.");
                SaveState(state);
                onProgress?.Invoke(ToSnapshot(state));
                throw;
            }
        }

        await ExecuteAsync("dataset", $"Preparing {DatasetVersion} without copying images…", async () =>
        {
            if (!File.Exists(paths.ManifestPath(DatasetVersion)))
            {
                var result = await RunCliAsync(
                    ["prepare-artwork", "--data-root", paths.DataRoot, "--dataset-version", DatasetVersion],
                    $"prepare-{DatasetVersion}", onLine, cancellationToken);
                state.Logs.Add(result.LogPath);
            }
            ValidateDataset();
            var report = ReadJson(Path.Combine(paths.DatasetRoot(DatasetVersion), "report.json"));
            var ambiguous = report.TryGetProperty("ambiguous_illustrations", out var count)
                ? count.GetInt32()
                : 0;
            return StageCompletion.Passed(
                $"Created or recovered the schema-v4 catalog; {ambiguous:N0} shared artworks are indexed but require ambiguity rejection.");
        });

        await ExecuteAsync("cuda", $"Testing {profile.GpuName} at batch {state.BatchSize}…", async () =>
        {
            var result = await RunCudaSmokeAsync(state, profile, onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            return StageCompletion.Passed(
                $"Selected {profile.GpuName} ({state.VramMiB:N0} MiB) and passed at batch {state.BatchSize}.");
        });

        var artifactRoot = paths.ArtifactRoot(modelVersion);
        var indexRoot = Path.Combine(artifactRoot, "index");
        var existingCheckpoint = Path.Combine(paths.ArtifactRoot(ExistingModelVersion), "best.pt");
        if (!IsComplete(state, "evidence_index") && !IsComplete(state, "evidence_evaluate"))
        {
            state.BootstrapTrainingRequired = RequiresBootstrapTraining(existingCheckpoint);
            SaveState(state);
        }

        await ExecuteAsync("evidence_index", state.BootstrapTrainingRequired
            ? "No prior model was found; preparing a clean training run…"
            : "Embedding every catalog artwork with the existing model…", async () =>
        {
            if (state.BootstrapTrainingRequired)
                return StageCompletion.Passed(
                    "No compatible prior checkpoint was found; initial artwork training will run from pretrained weights.");
            var result = await RunCliAsync(
                ["build-index", "--manifest", paths.ManifestPath(DatasetVersion),
                    "--checkpoint", existingCheckpoint, "--output-root", indexRoot,
                    "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
                    "--batch-size", state.BatchSize.ToString()],
                $"{modelVersion}-evidence-index", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            EnsureIndex(indexRoot);
            return StageCompletion.Passed("Built clean multi-view artwork prototypes from the existing checkpoint.");
        });

        await ExecuteAsync("evidence_evaluate", state.BootstrapTrainingRequired
            ? "Recording the clean-install bootstrap decision…"
            : "Applying independent calibration and strict retrieval gates…", async () =>
        {
            if (state.BootstrapTrainingRequired)
                return StageCompletion.Passed(
                    "Prior-model evaluation was skipped because this clean installation has no checkpoint to compare.");
            var reportPath = Path.Combine(artifactRoot, "retrieval-report.json");
            var result = await RunCliAsync(
                ["evaluate-index", "--manifest", paths.ManifestPath(DatasetVersion),
                    "--checkpoint", existingCheckpoint, "--index-root", indexRoot,
                    "--output", reportPath, "--device", "cuda",
                    "--cuda-device-index", state.GpuIndex.ToString(),
                    "--batch-size", state.BatchSize.ToString()],
                $"{modelVersion}-evidence-evaluate", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            state.Retrieval = ReadJson(reportPath);
            state.Qualified = state.Retrieval.Value.GetProperty("qualified").GetBoolean();
            state.SelectedCheckpointPath = existingCheckpoint;
            return state.Qualified
                ? StageCompletion.Passed("Existing embeddings passed the strict artwork gate; retraining is unnecessary.")
                : StageCompletion.Warning("Existing embeddings missed the strict gate; paired-view retraining will run.");
        });

        var trainedCheckpoint = Path.Combine(artifactRoot, "best.pt");
        await ExecuteAsync("train", state.Qualified
            ? "Recording the evidence-first skip decision…"
            : state.BootstrapTrainingRequired
                ? $"Training the initial artwork model through epoch {Epochs}…"
                : $"Training paired artwork views through epoch {Epochs}…", async () =>
        {
            if (state.Qualified)
                return StageCompletion.Passed("Skipped by design because the cheaper evidence run already qualified.");
            var lastCheckpoint = Path.Combine(artifactRoot, "last.pt");
            var arguments = new List<string>
            {
                "train-artwork", "--manifest", paths.ManifestPath(DatasetVersion),
                "--artifacts-root", paths.ArtifactsRoot, "--model-version", modelVersion,
                "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
                "--batch-size", state.BatchSize.ToString(), "--epochs", Epochs.ToString(),
                "--workers", Workers.ToString(), "--embedding-dim", EmbeddingDimension.ToString(),
                "--learning-rate", LearningRate, "--seed", Seed.ToString(), "--pretrained",
            };
            if (File.Exists(lastCheckpoint)) arguments.AddRange(["--resume", lastCheckpoint]);
            var result = await RunCliAsync(arguments, $"{modelVersion}-train-artwork", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            EnsureFile(trainedCheckpoint, "artwork best checkpoint");
            EnsureFile(lastCheckpoint, "artwork last checkpoint");
            state.CompletedEpoch = LastEpoch(result) ?? Epochs;
            state.SelectedCheckpointPath = trainedCheckpoint;
            return StageCompletion.Passed($"Completed paired-view artwork training through epoch {state.CompletedEpoch}.");
        });

        await ExecuteAsync("final_index", "Building and strictly qualifying the selected embedding index…", async () =>
        {
            if (state.Qualified)
                return StageCompletion.Passed("Reused the already-qualified evidence index without recomputation.");
            var checkpoint = state.SelectedCheckpointPath ?? trainedCheckpoint;
            var build = await RunCliAsync(
                ["build-index", "--manifest", paths.ManifestPath(DatasetVersion),
                    "--checkpoint", checkpoint, "--output-root", indexRoot,
                    "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString(),
                    "--batch-size", state.BatchSize.ToString()],
                $"{modelVersion}-final-index", onLine, cancellationToken);
            state.Logs.Add(build.LogPath);
            var reportPath = Path.Combine(artifactRoot, "retrieval-report.json");
            var evaluate = await RunCliAsync(
                ["evaluate-index", "--manifest", paths.ManifestPath(DatasetVersion),
                    "--checkpoint", checkpoint, "--index-root", indexRoot,
                    "--output", reportPath, "--device", "cuda",
                    "--cuda-device-index", state.GpuIndex.ToString(),
                    "--batch-size", state.BatchSize.ToString()],
                $"{modelVersion}-final-evaluate", onLine, cancellationToken);
            state.Logs.Add(evaluate.LogPath);
            state.Retrieval = ReadJson(reportPath);
            state.Qualified = state.Retrieval.Value.GetProperty("qualified").GetBoolean();
            return state.Qualified
                ? StageCompletion.Passed("The retrained embedding and final index passed every strict gate.")
                : StageCompletion.Warning("Artifacts were produced, but the final strict gate did not qualify.");
        });

        await ExecuteAsync("recognize", "Checking a known artwork and generated non-card…", async () =>
        {
            var sample = ReadKnownSample();
            state.ExpectedOracleId = sample.OracleId;
            state.ExpectedCardName = sample.CardName;
            var checkpoint = state.SelectedCheckpointPath
                ?? (File.Exists(trainedCheckpoint) ? trainedCheckpoint : existingCheckpoint);
            EnsureFile(checkpoint, "selected recognition checkpoint");
            var thresholds = Path.Combine(artifactRoot, "artwork-thresholds.json");
            var known = await RunCliAsync(
                ["recognize-index", "--checkpoint", checkpoint, "--index-root", indexRoot,
                    "--image", sample.ImagePath, "--thresholds", thresholds,
                    "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString()],
                $"{modelVersion}-recognize-known", onLine, cancellationToken);
            state.Logs.Add(known.LogPath);
            state.KnownRecognition = RequiredEvent(known, "prototype_recognition");
            var negative = await RunCliAsync(
                ["recognize-index", "--checkpoint", checkpoint, "--index-root", indexRoot,
                    "--image", WriteNegativeImage(modelVersion), "--thresholds", thresholds,
                    "--device", "cuda", "--cuda-device-index", state.GpuIndex.ToString()],
                $"{modelVersion}-recognize-negative", onLine, cancellationToken);
            state.Logs.Add(negative.LogPath);
            state.NegativeDiagnostic = RequiredEvent(negative, "prototype_recognition");
            var recognition = state.KnownRecognition.Value;
            state.KnownRecognitionPassed = !recognition.GetProperty("rejected").GetBoolean()
                && recognition.GetProperty("oracle_id").GetString() == sample.OracleId;
            return state.KnownRecognitionPassed
                ? StageCompletion.Passed($"Correctly recognized {sample.CardName}; non-card remains diagnostic only.")
                : StageCompletion.Warning($"Known artwork did not pass calibrated recognition for {sample.CardName}.");
        });

        string? provisionalZip = null;
        await ExecuteAsync("export", "Creating the schema-v4 checksummed result bundle…", async () =>
        {
            WriteReport(state, completed: false);
            provisionalZip = await exporter.ExportArtworkIdentityAsync(
                modelVersion, cancellationToken);
            state.ExportPath = provisionalZip;
            return StageCompletion.Passed($"Created {Path.GetFileName(provisionalZip)}.");
        });
        await ExecuteAsync("verify", "Reopening the ZIP and hashing every entry…", async () =>
        {
            var verified = await exporter.VerifyIdentityAsync(
                state.ExportPath ?? throw Inconsistent("Production export path is missing."), cancellationToken);
            return StageCompletion.Passed($"Verified all {verified.VerifiedEntries} checksummed entries.");
        });

        state.Completed = true;
        state.CompletedUtc = DateTime.UtcNow;
        state.Qualified = state.Qualified && state.KnownRecognitionPassed;
        WriteReport(state, completed: true);
        var finalZip = await exporter.ExportArtworkIdentityAsync(
            modelVersion, cancellationToken);
        await exporter.VerifyIdentityAsync(finalZip, cancellationToken);
        state.ExportPath = finalZip;
        SaveState(state);
        if (provisionalZip is not null && !provisionalZip.Equals(finalZip, StringComparison.OrdinalIgnoreCase)
            && File.Exists(provisionalZip)) File.Delete(provisionalZip);
        return ToSnapshot(state);
    }

    public string StartNewModelVersion()
    {
        var current = LoadState(ReadActiveModelVersion());
        if (current is not { Completed: true })
            throw new InvalidOperationException("Finish the active production run before starting a new model version.");
        var version = $"mobilenetv3s-512-art-v4-{DateTime.UtcNow:yyyyMMddTHHmmssZ}";
        if (Directory.Exists(paths.ArtifactRoot(version)) || File.Exists(StatePath(version)))
            throw new InvalidOperationException("A model version already exists for this UTC second. Try again.");
        Directory.CreateDirectory(paths.ProductionRoot);
        AtomicWriteText(ActiveModelPath, version + Environment.NewLine);
        return version;
    }

    public static int NextLowerBatch(int currentBatch) => Math.Max(16, currentBatch / 2);

    internal static bool RequiresBootstrapTraining(string existingCheckpointPath) =>
        !File.Exists(existingCheckpointPath);

    private async Task<PythonRunResult> RunCudaSmokeAsync(
        ProductionState state, CudaTrainingProfile profile, Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var result = await RunCliRawAsync(
            ["accelerator-smoke", "--manifest", paths.ManifestPath(DatasetVersion), "--device", "cuda",
                "--cuda-device-index", profile.DeviceIndex.ToString(), "--batch-size", state.BatchSize.ToString(),
                "--embedding-dim", EmbeddingDimension.ToString(), "--steps", "2"],
            $"{state.ModelVersion}-cuda-smoke-batch-{state.BatchSize}", onLine, cancellationToken);
        if (result.ExitCode != 0 && IsOutOfMemory(result))
        {
            state.BatchSize = NextLowerBatch(state.BatchSize);
            SaveState(state);
            result = await RunCliRawAsync(
                ["accelerator-smoke", "--manifest", paths.ManifestPath(DatasetVersion), "--device", "cuda",
                    "--cuda-device-index", profile.DeviceIndex.ToString(), "--batch-size", state.BatchSize.ToString(),
                    "--embedding-dim", EmbeddingDimension.ToString(), "--steps", "2"],
                $"{state.ModelVersion}-cuda-smoke-batch-{state.BatchSize}", onLine, cancellationToken);
        }
        EnsureSuccess(result);
        return result;
    }

    private async Task<PythonRunResult> RunCliAsync(
        IReadOnlyList<string> command, string logName, Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var result = await RunCliRawAsync(command, logName, onLine, cancellationToken);
        EnsureSuccess(result);
        return result;
    }

    private async Task<PythonRunResult> RunCliRawAsync(
        IReadOnlyList<string> command, string logName, Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var arguments = new List<string> { "-m", "deckino_training" };
        arguments.AddRange(command);
        return await runner.RunAsync(paths.VirtualEnvironmentPython, arguments, logName, onLine, cancellationToken);
    }

    private static void EnsureSuccess(PythonRunResult result)
    {
        if (result.ExitCode != 0)
            throw new InvalidOperationException($"Stage failed with exit code {result.ExitCode}. See {result.LogPath}");
    }

    private static bool IsOutOfMemory(PythonRunResult result) => result.Events.Any(element =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty("error_code", out var code)
        && code.GetString() == "cuda_out_of_memory");

    private void ValidateDataset()
    {
        EnsureFile(paths.ManifestPath(DatasetVersion), "artwork manifest");
        var metadata = ReadJson(Path.Combine(paths.DatasetRoot(DatasetVersion), "metadata.json"));
        if (metadata.GetProperty("schema_version").GetInt32() != 4
            || metadata.GetProperty("dataset_version").GetString() != DatasetVersion)
            throw Inconsistent("The artwork dataset metadata is incompatible.");
        EnsureFile(Path.Combine(paths.DatasetRoot(DatasetVersion), "labels.json"), "artwork labels");
        EnsureFile(Path.Combine(paths.DatasetRoot(DatasetVersion), "report.json"), "artwork dataset report");
    }

    private static void EnsureIndex(string indexRoot)
    {
        EnsureFile(Path.Combine(indexRoot, "index.f32"), "prototype vectors");
        EnsureFile(Path.Combine(indexRoot, "index-metadata.json"), "prototype index metadata");
        EnsureFile(Path.Combine(indexRoot, "index-labels.json"), "prototype labels");
    }

    private KnownSample ReadKnownSample()
    {
        var exportRoot = paths.DatasetRoot(DatasetVersion);
        var metadata = ReadJson(Path.Combine(exportRoot, "metadata.json"));
        var imageRoot = Path.GetFullPath(Path.Combine(exportRoot, metadata.GetProperty("image_root").GetString()!));
        foreach (var line in File.ReadLines(paths.ManifestPath(DatasetVersion)))
        {
            using var record = JsonDocument.Parse(line);
            var root = record.RootElement;
            if (root.GetProperty("role").GetString() != "test"
                || root.GetProperty("view_profile").GetString() != "mild") continue;
            var imagePath = Path.GetFullPath(Path.Combine(imageRoot,
                root.GetProperty("image_path").GetString()!.Replace('/', Path.DirectorySeparatorChar)));
            EnsureContained(imagePath, paths.DataRoot);
            return new KnownSample(imagePath, root.GetProperty("oracle_id").GetString()!,
                root.GetProperty("card_name").GetString()!);
        }
        throw Inconsistent("No deterministic artwork sample is available for recognition.");
    }

    private string WriteNegativeImage(string modelVersion)
    {
        var output = Path.Combine(paths.ProductionRoot, $"{modelVersion}-deterministic-non-card.ppm");
        const int size = 224;
        using var stream = File.Create(output);
        stream.Write(Encoding.ASCII.GetBytes($"P6\n{size} {size}\n255\n"));
        for (var y = 0; y < size; y++)
        for (var x = 0; x < size; x++)
        {
            var block = ((x / 16) + (y / 16)) % 2;
            stream.WriteByte((byte)(block == 0 ? 18 : 224));
            stream.WriteByte((byte)((x * 17 + y * 31 + Seed) & 255));
            stream.WriteByte((byte)(block == 0 ? 210 : 28));
        }
        return output;
    }

    private void WriteReport(ProductionState state, bool completed)
    {
        Directory.CreateDirectory(paths.ArtifactRoot(state.ModelVersion));
        AtomicWrite(Path.Combine(paths.ArtifactRoot(state.ModelVersion), "identity-report.json"), new
        {
            identity_report_schema_version = 2,
            artifact_schema_version = 4,
            dataset_version = DatasetVersion,
            model_version = state.ModelVersion,
            public_identity = "oracle_id",
            internal_identity = "artwork_id",
            evidence_first = true,
            clean_install_bootstrap = state.BootstrapTrainingRequired,
            retraining_performed = state.CompletedEpoch > 0,
            selected_checkpoint_source = state.CompletedEpoch > 0
                ? state.BootstrapTrainingRequired ? "initial_artwork_v4" : "paired_view_v4"
                : "existing_v3",
            seed = Seed,
            gpu_profile = new { device_index = state.GpuIndex, name = state.GpuName, vram_mib = state.VramMiB,
                profile = state.GpuProfile, effective_batch_size = state.BatchSize },
            configuration = new { max_epochs = Epochs, workers = Workers, embedding_dimension = EmbeddingDimension,
                learning_rate = LearningRate, pretrained = true, amp = true,
                retrieval = "maximum artwork cosine collapsed to oracle_id" },
            strict_targets = new { raw_top1 = 0.995, raw_top5 = 0.999, accepted_precision = 0.999,
                coverage = 0.95, subgroup_top1 = 0.99 },
            stages = StageDefinitions.Select(definition => state.Stages[definition.Id]),
            completed_epoch = state.CompletedEpoch,
            retrieval_evaluation = state.Retrieval,
            baseline_qualified = state.Qualified,
            camera_evaluated = false,
            camera_qualified = (bool?)null,
            expected_recognition = new { oracle_id = state.ExpectedOracleId, card_name = state.ExpectedCardName },
            actual_recognition = state.KnownRecognition,
            negative_diagnostic = state.NegativeDiagnostic,
            started_utc = state.StartedUtc,
            completed_utc = completed ? state.CompletedUtc : null,
            logs = state.Logs.Select(Path.GetFileName).Distinct(StringComparer.Ordinal).OrderBy(name => name),
        });
    }

    private void ValidateCompletedArtifacts(ProductionState state)
    {
        if (IsComplete(state, "dataset")) ValidateDataset();
        var artifactRoot = paths.ArtifactRoot(state.ModelVersion);
        if (IsComplete(state, "evidence_index") && !state.BootstrapTrainingRequired)
        {
            EnsureIndex(Path.Combine(artifactRoot, "index"));
            EnsureFile(Path.Combine(artifactRoot, "embedding.pt"), "compact embedding checkpoint");
        }
        if (IsComplete(state, "evidence_evaluate") && !state.BootstrapTrainingRequired)
            EnsureFile(Path.Combine(artifactRoot, "retrieval-report.json"), "retrieval report");
        if (IsComplete(state, "train") && state.CompletedEpoch > 0)
            EnsureFile(Path.Combine(artifactRoot, "best.pt"), "artwork checkpoint");
        if (IsComplete(state, "final_index"))
        {
            EnsureIndex(Path.Combine(artifactRoot, "index"));
            EnsureFile(Path.Combine(artifactRoot, "artwork-thresholds.json"), "artwork thresholds");
        }
        if (IsComplete(state, "export") && (state.ExportPath is null || !File.Exists(state.ExportPath)))
            throw Inconsistent("Recorded production result ZIP is missing.");
    }

    private string EnsureActiveModelVersion()
    {
        Directory.CreateDirectory(paths.ProductionRoot);
        if (!File.Exists(ActiveModelPath)) AtomicWriteText(ActiveModelPath, InitialModelVersion + Environment.NewLine);
        return ReadActiveModelVersion();
    }

    private string ReadActiveModelVersion()
    {
        if (!File.Exists(ActiveModelPath)) return InitialModelVersion;
        var value = File.ReadAllText(ActiveModelPath).Trim();
        if (string.IsNullOrWhiteSpace(value)
            || value.Any(character => !(char.IsLetterOrDigit(character) || character is '-' or '_')))
            throw Inconsistent("The active artwork model pointer is invalid.");
        return value;
    }

    private string StatePath(string modelVersion) => Path.Combine(paths.ProductionRoot, $"{modelVersion}-state.json");

    private ProductionState? LoadState(string modelVersion)
    {
        var path = StatePath(modelVersion);
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<ProductionState>(File.ReadAllText(path), JsonOptions)
                ?? throw Inconsistent("Production state is empty.");
        }
        catch (JsonException error)
        {
            throw Inconsistent($"Production state is unreadable: {error.Message}");
        }
    }

    private static ProductionState NewState(string modelVersion) => new()
    {
        ModelVersion = modelVersion,
        Stages = StageDefinitions.ToDictionary(definition => definition.Id,
            definition => new PersistedProductionStage(
                definition.Id, definition.Name, ProductionStageStatus.Pending, "Waiting."), StringComparer.Ordinal),
    };

    private static void ValidateIdentity(ProductionState state, string modelVersion)
    {
        if (state.SchemaVersion != StateSchemaVersion || state.DatasetVersion != DatasetVersion
            || state.ModelVersion != modelVersion || state.Seed != Seed)
            throw Inconsistent("Existing artwork production state belongs to a different workflow.");
    }

    private void SaveState(ProductionState state) => AtomicWrite(StatePath(state.ModelVersion), state);
    private static void SetStage(ProductionState state, string id, ProductionStageStatus status, string detail) =>
        state.Stages[id] = state.Stages[id] with { Status = status, Detail = detail };
    private static bool IsComplete(ProductionState state, string id) => state.Stages.TryGetValue(id, out var stage)
        && stage.Status is ProductionStageStatus.Passed or ProductionStageStatus.Warning;

    private static IdentityProductionSnapshot ToSnapshot(ProductionState state)
    {
        var outcome = state.Completed
            ? state.Qualified ? ProductionWorkflowOutcome.Passed : ProductionWorkflowOutcome.Warning
            : state.Stages.Values.Any(stage => stage.Status == ProductionStageStatus.Failed)
                ? ProductionWorkflowOutcome.Failed
                : state.Stages.Values.Any(stage => stage.Status == ProductionStageStatus.Running)
                    ? ProductionWorkflowOutcome.Running : ProductionWorkflowOutcome.Ready;
        var summary = outcome switch
        {
            ProductionWorkflowOutcome.Passed => "✓ Strict artwork retrieval baseline passed",
            ProductionWorkflowOutcome.Warning => "Artifacts exported · strict retrieval quality still needs improvement",
            ProductionWorkflowOutcome.Failed => "Artwork workflow stopped · review the activity log",
            ProductionWorkflowOutcome.Running => "Artwork retrieval workflow in progress",
            _ => "Ready to run or resume artwork retrieval qualification",
        };
        return new IdentityProductionSnapshot(outcome, summary, DatasetVersion, state.ModelVersion,
            StageDefinitions.Select(definition => state.Stages.TryGetValue(definition.Id, out var stage)
                    ? new ProductionStageResult(stage.Id, stage.Name, stage.Status, stage.Detail)
                    : new ProductionStageResult(definition.Id, definition.Name, ProductionStageStatus.Pending, "Waiting."))
                .ToArray(), state.GpuName, state.GpuProfile, state.BatchSize, state.CompletedEpoch,
            state.SelectedCheckpointPath is null ? null : Path.GetFileName(state.SelectedCheckpointPath),
            state.ExportPath, state.Completed);
    }

    private static IdentityProductionSnapshot EmptySnapshot(string modelVersion, string summary) => new(
        ProductionWorkflowOutcome.Ready, summary, DatasetVersion, modelVersion,
        StageDefinitions.Select(definition => new ProductionStageResult(
            definition.Id, definition.Name, ProductionStageStatus.Pending, "Waiting.")).ToArray());

    private static int? LastEpoch(PythonRunResult result)
    {
        var value = result.Events.LastOrDefault(element => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty("event", out var name) && name.GetString() == "artwork_epoch_completed");
        return value.ValueKind == JsonValueKind.Object ? value.GetProperty("epoch").GetInt32() : null;
    }

    private static JsonElement RequiredEvent(PythonRunResult result, string eventName)
    {
        var value = result.Events.LastOrDefault(element => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty("event", out var name) && name.GetString() == eventName);
        if (value.ValueKind == JsonValueKind.Undefined)
            throw new InvalidOperationException($"Python command did not emit required {eventName} event.");
        return value;
    }

    private static JsonElement ReadJson(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.Clone();
    }

    private static void EnsureFile(string path, string description)
    {
        if (!File.Exists(path)) throw Inconsistent($"Recorded {description} is missing.");
    }

    private static string EnsureContained(string target, string allowedRoot)
    {
        var fullTarget = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        var root = Path.GetFullPath(allowedRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!fullTarget.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"Path is outside the allowed Deckino root: {fullTarget}");
        return fullTarget;
    }

    private static InvalidOperationException Inconsistent(string detail) => new(
        $"{detail} Production state and artifacts disagree. Start a new model version or restore the missing artifact.");

    private static void AtomicWrite<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporaryPath = path + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(value, JsonOptions), Encoding.UTF8);
        File.Move(temporaryPath, path, overwrite: true);
    }

    private static void AtomicWriteText(string path, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporaryPath = path + ".tmp";
        File.WriteAllText(temporaryPath, value, Encoding.UTF8);
        File.Move(temporaryPath, path, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    private sealed record StageCompletion(ProductionStageStatus Status, string Detail)
    {
        public static StageCompletion Passed(string detail) => new(ProductionStageStatus.Passed, detail);
        public static StageCompletion Warning(string detail) => new(ProductionStageStatus.Warning, detail);
    }

    private sealed class ProductionState
    {
        public int SchemaVersion { get; set; } = StateSchemaVersion;
        public string DatasetVersion { get; set; } = IdentityProductionWorkflowService.DatasetVersion;
        public string ModelVersion { get; set; } = string.Empty;
        public int Seed { get; set; } = IdentityProductionWorkflowService.Seed;
        public DateTime StartedUtc { get; set; } = DateTime.UtcNow;
        public DateTime? CompletedUtc { get; set; }
        public bool Completed { get; set; }
        public bool Qualified { get; set; }
        public bool KnownRecognitionPassed { get; set; }
        public bool BootstrapTrainingRequired { get; set; }
        public string? GpuName { get; set; }
        public int GpuIndex { get; set; }
        public long VramMiB { get; set; }
        public string? GpuProfile { get; set; }
        public int BatchSize { get; set; }
        public int CompletedEpoch { get; set; }
        public string? SelectedCheckpointPath { get; set; }
        public Dictionary<string, PersistedProductionStage> Stages { get; set; } = new(StringComparer.Ordinal);
        public List<string> Logs { get; set; } = [];
        public JsonElement? Retrieval { get; set; }
        public string? ExpectedOracleId { get; set; }
        public string? ExpectedCardName { get; set; }
        public JsonElement? KnownRecognition { get; set; }
        public JsonElement? NegativeDiagnostic { get; set; }
        public string? ExportPath { get; set; }
    }

    private sealed record PersistedProductionStage(string Id, string Name, ProductionStageStatus Status, string Detail);
    private sealed record KnownSample(string ImagePath, string OracleId, string CardName);
}
