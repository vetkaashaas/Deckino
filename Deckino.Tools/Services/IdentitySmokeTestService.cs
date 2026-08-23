using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Deckino.Tools.Services;

public enum SmokeStageStatus { Pending, Running, Passed, Failed }

public sealed record SmokeStageResult(string Id, string Name, SmokeStageStatus Status, string Detail);

public sealed record IdentitySmokeSnapshot(
    bool Passed,
    string Summary,
    IReadOnlyList<SmokeStageResult> Stages,
    string? ExportPath = null);

public sealed class IdentitySmokeTestService(
    TrainingPaths paths,
    PythonProcessRunner runner,
    TrainingResultExporter exporter)
{
    public const string DatasetVersion = "paper-smoke20-v3";
    public const string ModelVersion = "mobilenetv3s-512-smoke20-v3";
    public const int Seed = 20260823;
    private const int StateSchemaVersion = 1;
    private static readonly (string Id, string Name)[] StageDefinitions =
    [
        ("subset", "20-class subset"),
        ("cuda", "CUDA batch-64 smoke"),
        ("epoch1", "Train epoch one"),
        ("resume", "Resume through epoch ten"),
        ("evaluate", "Evaluation and thresholds"),
        ("recognize", "Known held-out recognition"),
        ("export", "Export result ZIP"),
        ("verify", "Verify SHA-256 checksums"),
    ];

    public string StatePath => Path.Combine(paths.SmokeRoot, "identity-smoke-state.json");
    public string NegativeImagePath => Path.Combine(paths.SmokeRoot, "deterministic-non-card.ppm");
    public string MarkerPath => Path.Combine(paths.SmokeRoot, "identity-smoke-v1.ok");

    public IdentitySmokeSnapshot Inspect(string sourceDatasetVersion)
    {
        var state = LoadState();
        if (state is null) return EmptySnapshot("Ready to run the isolated quick test.");
        ValidateIdentity(state, sourceDatasetVersion);
        ValidateCompletedArtifacts(state);
        if (IsPassed(state, "verify"))
        {
            exporter.Verify(
                state.ExportPath ?? throw Inconsistent("Smoke export path is missing."),
                requireSmokeReport: true);
        }
        return ToSnapshot(state);
    }

    public async Task<IdentitySmokeSnapshot> RunAsync(
        string sourceDatasetVersion,
        Action<string, JsonElement?> onLine,
        Action<IdentitySmokeSnapshot>? onProgress,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(paths.ManifestPath(sourceDatasetVersion)))
        {
            throw new InvalidOperationException(
                $"Source manifest {sourceDatasetVersion} is missing. Prepare the production dataset first.");
        }
        Directory.CreateDirectory(paths.SmokeRoot);
        var state = LoadState() ?? NewState(sourceDatasetVersion);
        ValidateIdentity(state, sourceDatasetVersion);
        ValidateCompletedArtifacts(state);
        if (state.Passed)
        {
            await exporter.VerifyAsync(
                state.ExportPath ?? throw Inconsistent("Smoke export path is missing."),
                requireSmokeReport: true,
                cancellationToken);
            return ToSnapshot(state);
        }

        async Task ExecuteAsync(string id, string detail, Func<Task<string>> action)
        {
            if (IsPassed(state, id)) return;
            SetStage(state, id, SmokeStageStatus.Running, detail);
            SaveState(state);
            onProgress?.Invoke(ToSnapshot(state));
            try
            {
                var completedDetail = await action();
                SetStage(state, id, SmokeStageStatus.Passed, completedDetail);
                SaveState(state);
                onProgress?.Invoke(ToSnapshot(state));
            }
            catch
            {
                SetStage(state, id, SmokeStageStatus.Failed, "Stage failed. Review the activity log.");
                SaveState(state);
                onProgress?.Invoke(ToSnapshot(state));
                throw;
            }
        }

        await ExecuteAsync("subset", "Deriving subset without copying images…", async () =>
        {
            if (Directory.Exists(paths.DatasetRoot(DatasetVersion)))
            {
                ValidateSubset(sourceDatasetVersion);
                return "Recovered the valid 20-class subset.";
            }
            var result = await RunCliAsync(
                ["subset", "--source-manifest", paths.ManifestPath(sourceDatasetVersion),
                    "--dataset-version", DatasetVersion, "--max-classes", "20",
                    "--min-images-per-class", "3"],
                $"{ModelVersion}-subset", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            ValidateSubset(sourceDatasetVersion);
            return "20 classes selected; source images were referenced in place.";
        });

        await ExecuteAsync("cuda", "Testing two CUDA optimizer steps at batch 64…", async () =>
        {
            var result = await RunCliAsync(
                ["accelerator-smoke", "--manifest", paths.ManifestPath(DatasetVersion),
                    "--device", "cuda", "--batch-size", "64", "--embedding-dim", "512", "--steps", "2"],
                $"{ModelVersion}-cuda-smoke", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            return "CUDA forward, backward, and optimizer steps passed.";
        });

        var lastCheckpoint = Path.Combine(paths.ArtifactRoot(ModelVersion), "last.pt");
        JsonElement? checkpoint = File.Exists(lastCheckpoint)
            ? await ReadCheckpointAsync(lastCheckpoint, onLine, cancellationToken)
            : null;
        if (checkpoint is not null)
        {
            ValidateCheckpoint(checkpoint.Value);
            if (checkpoint.Value.GetProperty("completed_epoch").GetInt32() >= 1)
                RecoverStage(state, "epoch1", "Recovered epoch-one checkpoint.");
            if (checkpoint.Value.GetProperty("completed_epoch").GetInt32() >= 10)
                RecoverStage(state, "resume", "Recovered completed epoch-ten checkpoint.");
        }

        await ExecuteAsync("epoch1", "Training the first smoke epoch…", async () =>
        {
            var result = await RunTrainAsync(1, resume: false, onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            EnsureCheckpoints();
            return "Epoch one completed with best.pt and last.pt.";
        });

        await ExecuteAsync("resume", "Restoring optimizer state and training to epoch ten…", async () =>
        {
            var before = await ReadCheckpointAsync(lastCheckpoint, onLine, cancellationToken);
            ValidateCheckpoint(before);
            var resumeEpoch = before.GetProperty("completed_epoch").GetInt32();
            if (resumeEpoch is < 1 or >= 10)
                throw Inconsistent("Resume expected a checkpoint between epochs one and nine.");
            if (!before.GetProperty("optimizer_state_present").GetBoolean())
                throw Inconsistent("Epoch-one checkpoint has no optimizer state.");
            var result = await RunTrainAsync(10, resume: true, onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            var resumed = result.Events.FirstOrDefault(IsEvent("checkpoint_resumed"));
            if (resumed.ValueKind == JsonValueKind.Undefined
                || resumed.GetProperty("completed_epoch").GetInt32() != resumeEpoch)
                throw new InvalidOperationException("Training did not prove optimizer-backed checkpoint resume.");
            state.ResumeEvidence = resumed;
            var after = await ReadCheckpointAsync(lastCheckpoint, onLine, cancellationToken);
            ValidateCheckpoint(after);
            if (after.GetProperty("completed_epoch").GetInt32() != 10)
                throw new InvalidOperationException("Resumed training did not finish epoch ten.");
            return $"Optimizer state restored from epoch {resumeEpoch}; epoch ten completed.";
        });

        var bestCheckpoint = Path.Combine(paths.ArtifactRoot(ModelVersion), "best.pt");
        await ExecuteAsync("evaluate", "Evaluating and calibrating thresholds…", async () =>
        {
            var result = await RunCliAsync(
                ["evaluate", "--manifest", paths.ManifestPath(DatasetVersion),
                    "--checkpoint", bestCheckpoint, "--device", "cuda", "--batch-size", "16", "--workers", "4"],
                $"{ModelVersion}-evaluate", onLine, cancellationToken);
            state.Logs.Add(result.LogPath);
            state.Evaluation = RequiredEvent(result, "evaluation_completed");
            EnsureFile(Path.Combine(paths.ArtifactRoot(ModelVersion), "evaluation.json"), "evaluation report");
            EnsureFile(Path.Combine(paths.ArtifactRoot(ModelVersion), "thresholds.json"), "thresholds");
            return "Evaluation and calibrated thresholds were written (production gates ignored).";
        });

        await ExecuteAsync("recognize", "Checking a deterministic held-out sample…", async () =>
        {
            var sample = ReadKnownSample(state.Evaluation);
            var known = await RunCliAsync(
                ["recognize", "--checkpoint", bestCheckpoint, "--image", sample.ImagePath,
                    "--device", "cuda", "--input-kind", "art",
                    "--score-threshold", "-1", "--margin-threshold", "-1"],
                $"{ModelVersion}-recognize-known", onLine, cancellationToken);
            state.Logs.Add(known.LogPath);
            var recognition = RequiredEvent(known, "recognition");
            state.ExpectedOracleId = sample.OracleId;
            state.ExpectedCardName = sample.CardName;
            state.KnownRecognition = recognition;
            if (recognition.GetProperty("rejected").GetBoolean()
                || recognition.GetProperty("oracle_id").GetString() != sample.OracleId)
            {
                throw new InvalidOperationException(
                    $"Known-sample learning gate failed. Expected {sample.CardName} ({sample.OracleId}).");
            }

            WriteNegativeImage();
            var negative = await RunCliAsync(
                ["recognize", "--checkpoint", bestCheckpoint, "--image", NegativeImagePath,
                    "--device", "cuda", "--input-kind", "art"],
                $"{ModelVersion}-recognize-negative", onLine, cancellationToken);
            state.Logs.Add(negative.LogPath);
            state.NegativeDiagnostic = RequiredEvent(negative, "recognition");
            return $"Correctly recognized {sample.CardName}; non-card result recorded diagnostically.";
        });

        var provisionalZip = state.ExportPath;
        await ExecuteAsync("export", "Creating the checksummed smoke bundle…", async () =>
        {
            WriteReport(state, finalStages: false);
            provisionalZip = await exporter.ExportAsync(ModelVersion, smoke: true, cancellationToken);
            state.ExportPath = provisionalZip;
            return $"Created {Path.GetFileName(provisionalZip)}.";
        });
        await ExecuteAsync("verify", "Reopening the ZIP and hashing every entry…", async () =>
        {
            var zip = state.ExportPath ?? throw Inconsistent("Smoke export path is missing.");
            var verified = await exporter.VerifyAsync(zip, requireSmokeReport: true, cancellationToken);
            return $"Verified all {verified.VerifiedEntries} checksummed entries.";
        });

        state.Passed = true;
        state.CompletedUtc = DateTime.UtcNow;
        WriteReport(state, finalStages: true);
        var finalZip = await exporter.ExportAsync(ModelVersion, smoke: true, cancellationToken);
        await exporter.VerifyAsync(finalZip, requireSmokeReport: true, cancellationToken);
        state.ExportPath = finalZip;
        File.WriteAllText(MarkerPath, $"{DatasetVersion}\n{ModelVersion}\n", Encoding.UTF8);
        SaveState(state);
        if (provisionalZip is not null && File.Exists(provisionalZip)) File.Delete(provisionalZip);
        return ToSnapshot(state);
    }

    public void Reset()
    {
        DeleteContainedDirectory(paths.DatasetRoot(DatasetVersion), paths.ExportsRoot);
        DeleteContainedDirectory(paths.ArtifactRoot(ModelVersion), paths.ArtifactsRoot);
        DeleteContainedDirectory(paths.SmokeRoot, paths.TrainingRoot);
    }

    private async Task<PythonRunResult> RunTrainAsync(
        int epochs, bool resume, Action<string, JsonElement?> onLine, CancellationToken cancellationToken)
    {
        var arguments = new List<string>
        {
            "train", "--manifest", paths.ManifestPath(DatasetVersion),
            "--artifacts-root", paths.ArtifactsRoot, "--model-version", ModelVersion,
            "--device", "cuda", "--batch-size", "16", "--epochs", epochs.ToString(),
            "--workers", "4", "--embedding-dim", "512", "--learning-rate", "3e-4",
            "--seed", Seed.ToString(), "--pretrained",
        };
        if (resume) arguments.AddRange(["--resume", Path.Combine(paths.ArtifactRoot(ModelVersion), "last.pt")]);
        return await RunCliAsync(arguments, $"{ModelVersion}-train-to-{epochs}", onLine, cancellationToken);
    }

    private async Task<PythonRunResult> RunCliAsync(
        IReadOnlyList<string> command, string logName,
        Action<string, JsonElement?> onLine, CancellationToken cancellationToken)
    {
        var arguments = new List<string> { "-m", "deckino_training" };
        arguments.AddRange(command);
        var result = await runner.RunAsync(paths.VirtualEnvironmentPython, arguments, logName, onLine, cancellationToken);
        if (result.ExitCode != 0)
            throw new InvalidOperationException($"Stage failed with exit code {result.ExitCode}. See {result.LogPath}");
        return result;
    }

    private async Task<JsonElement> ReadCheckpointAsync(
        string checkpointPath, Action<string, JsonElement?> onLine, CancellationToken cancellationToken)
    {
        var result = await RunCliAsync(
            ["checkpoint-info", "--checkpoint", checkpointPath],
            $"{ModelVersion}-checkpoint-info", onLine, cancellationToken);
        return RequiredEvent(result, "checkpoint_info");
    }

    private void ValidateSubset(string sourceDatasetVersion)
    {
        var metadataPath = Path.Combine(paths.DatasetRoot(DatasetVersion), "metadata.json");
        EnsureFile(metadataPath, "smoke metadata");
        using var document = JsonDocument.Parse(File.ReadAllText(metadataPath));
        var root = document.RootElement;
        if (root.GetProperty("schema_version").GetInt32() != 3
            || root.GetProperty("dataset_version").GetString() != DatasetVersion
            || root.GetProperty("source_dataset_version").GetString() != sourceDatasetVersion
            || root.GetProperty("classes").GetInt32() != 20
            || root.GetProperty("selection").GetProperty("min_images_per_class").GetInt32() != 3)
            throw Inconsistent("Existing smoke subset does not match the fixed workflow.");
        EnsureFile(paths.ManifestPath(DatasetVersion), "smoke manifest");
        EnsureFile(Path.Combine(paths.DatasetRoot(DatasetVersion), "labels.json"), "smoke labels");
        EnsureFile(Path.Combine(paths.DatasetRoot(DatasetVersion), "report.json"), "smoke subset report");
    }

    private void ValidateCheckpoint(JsonElement checkpoint)
    {
        if (checkpoint.GetProperty("artifact_schema_version").GetInt32() != 3
            || checkpoint.GetProperty("dataset_version").GetString() != DatasetVersion
            || checkpoint.GetProperty("model_version").GetString() != ModelVersion
            || checkpoint.GetProperty("class_count").GetInt32() != 20
            || checkpoint.GetProperty("embedding_dim").GetInt32() != 512
            || checkpoint.GetProperty("seed").GetInt32() != Seed)
            throw Inconsistent("Existing checkpoint is incompatible with the fixed smoke workflow.");
    }

    private KnownSample ReadKnownSample(JsonElement? evaluation)
    {
        if (evaluation is not { ValueKind: JsonValueKind.Object } evaluationRoot)
            throw Inconsistent("Evaluation evidence is unavailable for held-out sample selection.");
        var incorrectOracleIds = evaluationRoot
            .GetProperty("groups")
            .GetProperty("held_out_artwork")
            .GetProperty("confusion_pairs")
            .EnumerateArray()
            .Select(pair => pair.GetProperty("actual_oracle_id").GetString()!)
            .ToHashSet(StringComparer.Ordinal);
        var exportRoot = paths.DatasetRoot(DatasetVersion);
        using var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(exportRoot, "metadata.json")));
        var imageRoot = Path.GetFullPath(Path.Combine(exportRoot, metadata.RootElement.GetProperty("image_root").GetString()!));
        var heldOutRecords = new List<(string ImagePath, string OracleId, string CardName)>();
        foreach (var line in File.ReadLines(paths.ManifestPath(DatasetVersion)))
        {
            using var record = JsonDocument.Parse(line);
            var root = record.RootElement;
            if (root.GetProperty("split").GetString() != "validation"
                || root.GetProperty("validation_kind").GetString() != "held_out_artwork") continue;
            var imagePath = Path.GetFullPath(Path.Combine(imageRoot,
                root.GetProperty("image_path").GetString()!.Replace('/', Path.DirectorySeparatorChar)));
            EnsureContained(imagePath, paths.DataRoot);
            heldOutRecords.Add((
                imagePath,
                root.GetProperty("oracle_id").GetString()!,
                root.GetProperty("card_name").GetString()!));
        }
        var selectedOracleId = SelectKnownOracleId(
            heldOutRecords.Select(record => record.OracleId), incorrectOracleIds);
        var selected = heldOutRecords.First(record => record.OracleId == selectedOracleId);
        return new KnownSample(selected.ImagePath, selected.OracleId, selected.CardName);
    }

    public static string SelectKnownOracleId(
        IEnumerable<string> manifestOrderedOracleIds,
        IReadOnlySet<string> incorrectOracleIds)
    {
        return manifestOrderedOracleIds.FirstOrDefault(oracleId => !incorrectOracleIds.Contains(oracleId))
            ?? throw new InvalidOperationException(
                "The quick model did not correctly classify any held-out artwork. Reset the quick test before retrying with revised training settings.");
    }

    private void WriteNegativeImage()
    {
        const int size = 224;
        using var stream = File.Create(NegativeImagePath);
        var header = Encoding.ASCII.GetBytes($"P6\n{size} {size}\n255\n");
        stream.Write(header);
        for (var y = 0; y < size; y++)
        for (var x = 0; x < size; x++)
        {
            var block = ((x / 16) + (y / 16)) % 2;
            stream.WriteByte((byte)(block == 0 ? 18 : 224));
            stream.WriteByte((byte)((x * 17 + y * 31 + Seed) & 255));
            stream.WriteByte((byte)(block == 0 ? 210 : 28));
        }
    }

    private void WriteReport(SmokeState state, bool finalStages)
    {
        Directory.CreateDirectory(paths.ArtifactRoot(ModelVersion));
        var report = new
        {
            smoke_report_schema_version = 1,
            artifact_schema_version = 3,
            source_dataset_version = state.SourceDatasetVersion,
            dataset_version = DatasetVersion,
            model_version = ModelVersion,
            seed = Seed,
            selected_classes = ReadJson(Path.Combine(paths.DatasetRoot(DatasetVersion), "labels.json")),
            sample_counts = ReadJson(Path.Combine(paths.DatasetRoot(DatasetVersion), "report.json")),
            stages = state.Stages.Values.OrderBy(stage => Array.FindIndex(StageDefinitions, item => item.Id == stage.Id)),
            checkpoint_resume_evidence = state.ResumeEvidence,
            evaluation_summary = state.Evaluation,
            expected_recognition = new { oracle_id = state.ExpectedOracleId, card_name = state.ExpectedCardName },
            actual_recognition = state.KnownRecognition,
            negative_diagnostic = state.NegativeDiagnostic,
            started_utc = state.StartedUtc,
            completed_utc = finalStages ? state.CompletedUtc : null,
            logs = state.Logs.Select(Path.GetFileName).Distinct(StringComparer.Ordinal).OrderBy(name => name),
        };
        AtomicWrite(Path.Combine(paths.ArtifactRoot(ModelVersion), "smoke-report.json"), report);
    }

    private static JsonElement ReadJson(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.Clone();
    }

    private void ValidateCompletedArtifacts(SmokeState state)
    {
        if (IsPassed(state, "subset")) ValidateSubset(state.SourceDatasetVersion);
        if (IsPassed(state, "epoch1")) EnsureCheckpoints();
        if (IsPassed(state, "evaluate"))
        {
            EnsureFile(Path.Combine(paths.ArtifactRoot(ModelVersion), "evaluation.json"), "evaluation report");
            EnsureFile(Path.Combine(paths.ArtifactRoot(ModelVersion), "thresholds.json"), "thresholds");
        }
        if (IsPassed(state, "export") && (state.ExportPath is null || !File.Exists(state.ExportPath)))
            throw Inconsistent("Recorded smoke result ZIP is missing.");
        if (state.Passed)
        {
            if (!File.Exists(MarkerPath)) throw Inconsistent("Smoke pass marker is missing.");
            var marker = File.ReadAllLines(MarkerPath);
            if (marker.Length < 2 || marker[0] != DatasetVersion || marker[1] != ModelVersion)
                throw Inconsistent("Smoke pass marker has incompatible versions.");
        }
    }

    private void EnsureCheckpoints()
    {
        EnsureFile(Path.Combine(paths.ArtifactRoot(ModelVersion), "best.pt"), "best checkpoint");
        EnsureFile(Path.Combine(paths.ArtifactRoot(ModelVersion), "last.pt"), "last checkpoint");
    }

    private static void EnsureFile(string path, string description)
    {
        if (!File.Exists(path)) throw Inconsistent($"Recorded {description} is missing.");
    }

    private static Func<JsonElement, bool> IsEvent(string name) => element =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty("event", out var property)
        && property.GetString() == name;

    private static JsonElement RequiredEvent(PythonRunResult result, string name)
    {
        var value = result.Events.LastOrDefault(IsEvent(name));
        if (value.ValueKind == JsonValueKind.Undefined)
            throw new InvalidOperationException($"Python command did not emit required {name} event.");
        return value;
    }

    private SmokeState? LoadState()
    {
        if (!File.Exists(StatePath)) return null;
        try
        {
            return JsonSerializer.Deserialize<SmokeState>(File.ReadAllText(StatePath), JsonOptions)
                ?? throw Inconsistent("Smoke state is empty.");
        }
        catch (JsonException error)
        {
            throw Inconsistent($"Smoke state is unreadable: {error.Message}");
        }
    }

    private static SmokeState NewState(string sourceDatasetVersion) => new()
    {
        SourceDatasetVersion = sourceDatasetVersion,
        Stages = StageDefinitions.ToDictionary(
            definition => definition.Id,
            definition => new PersistedStage(definition.Id, definition.Name, SmokeStageStatus.Pending, "Waiting."),
            StringComparer.Ordinal),
    };

    private static void ValidateIdentity(SmokeState state, string sourceDatasetVersion)
    {
        if (state.SchemaVersion != StateSchemaVersion || state.SourceDatasetVersion != sourceDatasetVersion
            || state.DatasetVersion != DatasetVersion || state.ModelVersion != ModelVersion || state.Seed != Seed)
            throw Inconsistent("Existing smoke state belongs to a different workflow.");
    }

    private void SaveState(SmokeState state) => AtomicWrite(StatePath, state);

    private static void AtomicWrite<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporaryPath = path + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(value, JsonOptions), Encoding.UTF8);
        File.Move(temporaryPath, path, overwrite: true);
    }

    private static void SetStage(SmokeState state, string id, SmokeStageStatus status, string detail) =>
        state.Stages[id] = state.Stages[id] with { Status = status, Detail = detail };

    private void RecoverStage(SmokeState state, string id, string detail)
    {
        if (IsPassed(state, id)) return;
        SetStage(state, id, SmokeStageStatus.Passed, detail);
        SaveState(state);
    }

    private static bool IsPassed(SmokeState state, string id) =>
        state.Stages.TryGetValue(id, out var stage) && stage.Status == SmokeStageStatus.Passed;

    private static IdentitySmokeSnapshot ToSnapshot(SmokeState state) => new(
        state.Passed,
        state.Passed ? "✓ Quick identity workflow passed" : "Quick identity workflow in progress",
        StageDefinitions.Select(definition => state.Stages.TryGetValue(definition.Id, out var stage)
            ? new SmokeStageResult(stage.Id, stage.Name, stage.Status, stage.Detail)
            : new SmokeStageResult(definition.Id, definition.Name, SmokeStageStatus.Pending, "Waiting.")).ToArray(),
        state.ExportPath);

    private static IdentitySmokeSnapshot EmptySnapshot(string summary) => new(
        false, summary,
        StageDefinitions.Select(definition =>
            new SmokeStageResult(definition.Id, definition.Name, SmokeStageStatus.Pending, "Waiting.")).ToArray());

    private static InvalidOperationException Inconsistent(string detail) => new(
        $"{detail} Smoke state and artifacts disagree. Use Reset quick test before continuing.");

    private static void DeleteContainedDirectory(string target, string allowedRoot)
    {
        var fullTarget = EnsureContained(target, allowedRoot);
        if (fullTarget.Equals(Path.GetFullPath(allowedRoot).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Refusing to delete an entire workspace root.");
        if (Directory.Exists(fullTarget)) Directory.Delete(fullTarget, recursive: true);
    }

    private static string EnsureContained(string target, string allowedRoot)
    {
        var fullTarget = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        var root = Path.GetFullPath(allowedRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!fullTarget.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"Path is outside the allowed Deckino root: {fullTarget}");
        return fullTarget;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    private sealed class SmokeState
    {
        public int SchemaVersion { get; set; } = StateSchemaVersion;
        public string SourceDatasetVersion { get; set; } = string.Empty;
        public string DatasetVersion { get; set; } = IdentitySmokeTestService.DatasetVersion;
        public string ModelVersion { get; set; } = IdentitySmokeTestService.ModelVersion;
        public int Seed { get; set; } = IdentitySmokeTestService.Seed;
        public DateTime StartedUtc { get; set; } = DateTime.UtcNow;
        public DateTime? CompletedUtc { get; set; }
        public bool Passed { get; set; }
        public Dictionary<string, PersistedStage> Stages { get; set; } = new(StringComparer.Ordinal);
        public List<string> Logs { get; set; } = [];
        public JsonElement? ResumeEvidence { get; set; }
        public JsonElement? Evaluation { get; set; }
        public string? ExpectedOracleId { get; set; }
        public string? ExpectedCardName { get; set; }
        public JsonElement? KnownRecognition { get; set; }
        public JsonElement? NegativeDiagnostic { get; set; }
        public string? ExportPath { get; set; }
    }

    private sealed record PersistedStage(string Id, string Name, SmokeStageStatus Status, string Detail);
    private sealed record KnownSample(string ImagePath, string OracleId, string CardName);
}
