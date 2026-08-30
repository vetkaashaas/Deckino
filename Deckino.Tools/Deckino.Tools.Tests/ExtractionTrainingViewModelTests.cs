using Deckino.Tools.Services;
using Deckino.Tools.ViewModels;
using Deckino.Tools.Data;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Deckino.Tools.Tests;

public sealed class ExtractionTrainingViewModelTests
{
    [Fact]
    public void EmptyWorkflowExposesNineOrderedExtractionStages()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new ExtractionProductionWorkflowService(
                paths,
                new PythonProcessRunner(paths),
                new TrainingResultExporter(paths));

            var snapshot = service.Inspect();

            Assert.Equal(ProductionWorkflowOutcome.Ready, snapshot.Outcome);
            Assert.Equal("corners-v1", snapshot.DatasetVersion);
            Assert.Equal("extractor-mnv3-geometry-320-recipe4", snapshot.ModelVersion);
            Assert.False(snapshot.IncludeSyntheticCards);
            Assert.Equal(
                ["inputs", "dataset", "cuda", "quick", "train", "evaluate", "diagnostics", "export", "verify"],
                snapshot.Stages.Select(stage => stage.Id));
            Assert.All(snapshot.Stages, stage => Assert.Equal(ProductionStageStatus.Pending, stage.Status));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SyntheticCheckboxDefaultsOffAndUpdatesCacheExplanation()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-options-{Guid.NewGuid():N}");
        var paths = new TrainingPaths(root);
        var runner = new PythonProcessRunner(paths);
        var database = new Database(Path.Combine(root, "deckino.db"));
        using var http = new HttpClient();
        using var scryfall = new ScryfallClient(60);
        var viewModel = new ExtractionTrainingViewModel(
            paths, new TrainingEnvironmentService(paths, runner, http),
            new ExtractionProductionWorkflowService(paths, runner, new TrainingResultExporter(paths)),
            new ExtractionAssetDownloadService(database, paths, http),
            new BulkDataSyncService(database, scryfall, new SyncOptions { DataRoot = root }),
            new WorkspaceOperationCoordinator(), new ApplicationLogService(paths.LogsRoot));

        Assert.False(viewModel.IncludeSyntheticCards);
        Assert.True(viewModel.CanChangeTrainingOptions);
        Assert.Contains("no full-card cache is needed", viewModel.AssetSummary);
        viewModel.IncludeSyntheticCards = true;
        Assert.Contains("cached automatically", viewModel.AssetSummary);
        viewModel.IncludeSyntheticCards = false;
        Assert.Contains("no full-card cache is needed", viewModel.AssetSummary);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    public async Task InterruptedRunResumesOnlyWithTheSameSyntheticSetting(bool original, bool selected, bool fresh)
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-mode-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new ExtractionProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var profile = TrainingEnvironmentService.CreateTrainingProfile(0, "Test GPU", 8192);
            // Stop at input inspection without launching Python or downloading anything.
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(
                profile, (_, _) => { }, null, CancellationToken.None, original));
            var first = service.Inspect();
            var checkpoint = Path.Combine(paths.ArtifactRoot(first.ModelVersion), "last.pt");
            File.WriteAllText(checkpoint, "retained checkpoint");

            // Reconstruct the service to verify persisted state, not just in-memory options.
            service = new ExtractionProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(
                profile, (_, _) => { }, null, CancellationToken.None, selected));
            var next = service.Inspect();

            Assert.Equal(fresh, first.ModelVersion != next.ModelVersion);
            Assert.Equal(selected, next.IncludeSyntheticCards);
            Assert.Equal("retained checkpoint", File.ReadAllText(checkpoint));
            using var state = JsonDocument.Parse(File.ReadAllText(Path.Combine(paths.ArtifactRoot(next.ModelVersion), "workflow-state.json")));
            Assert.Equal(selected, state.RootElement.GetProperty("IncludeSyntheticCards").GetBoolean());
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LegacyRunWithoutOptionIsTreatedAsSyntheticEnabled(bool selected)
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-legacy-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new ExtractionProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var profile = TrainingEnvironmentService.CreateTrainingProfile(0, "Test GPU", 8192);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(
                profile, (_, _) => { }, null, CancellationToken.None, true));
            var first = service.Inspect();
            var statePath = Path.Combine(paths.ExtractionProductionRoot, $"{first.ModelVersion}-state.json");
            var legacyState = JsonNode.Parse(File.ReadAllText(statePath))!.AsObject();
            legacyState.Remove("IncludeSyntheticCards");
            File.WriteAllText(statePath, legacyState.ToJsonString());

            Assert.True(service.Inspect().IncludeSyntheticCards);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(
                profile, (_, _) => { }, null, CancellationToken.None, selected));
            Assert.Equal(selected, first.ModelVersion == service.Inspect().ModelVersion);
            Assert.Equal(selected, service.Inspect().IncludeSyntheticCards);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task PreviousArchitectureStartsFreshAndRetainsItsPreviewCheckpoint()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-extraction-recipe-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new ExtractionProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var profile = TrainingEnvironmentService.CreateTrainingProfile(0, "Test GPU", 8192);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(profile, (_, _) => { }, null, CancellationToken.None));
            var first = service.Inspect();
            var checkpoint = Path.Combine(paths.ArtifactRoot(first.ModelVersion), "best.pt");
            File.WriteAllText(checkpoint, "previous preview checkpoint");
            var statePath = Path.Combine(paths.ExtractionProductionRoot, $"{first.ModelVersion}-state.json");
            var state = JsonNode.Parse(File.ReadAllText(statePath))!.AsObject();
            state["SchemaVersion"] = 1;
            state["TrainingRecipeVersion"] = 1;
            File.WriteAllText(statePath, state.ToJsonString());
            Assert.Equal(ProductionWorkflowOutcome.Ready, service.Inspect().Outcome);
            Assert.Equal(first.ModelVersion, service.ActiveModelVersion);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(profile, (_, _) => { }, null, CancellationToken.None));
            Assert.NotEqual(first.ModelVersion, service.Inspect().ModelVersion);
            Assert.Equal("previous preview checkpoint", File.ReadAllText(checkpoint));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(64, 32)]
    [InlineData(32, 16)]
    [InlineData(16, 8)]
    public void OomFallbackUsesTheNextSafeExtractionBatch(int current, int expected)
    {
        Assert.Equal(expected, ExtractionProductionWorkflowService.NextLowerBatch(current));
    }

    [Fact]
    public async Task FreshRunsRetainCompletedBaselineAcrossAnUnfinishedCandidate()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-baseline-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new ExtractionProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var profile = TrainingEnvironmentService.CreateTrainingProfile(0, "Test GPU", 8192);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(profile, (_, _) => { }, null, CancellationToken.None));
            var baseline = service.ActiveModelVersion;
            File.WriteAllText(Path.Combine(paths.ArtifactRoot(baseline), "best.pt"), "preserved baseline");
            File.WriteAllText(Path.Combine(paths.ArtifactRoot(baseline), "evaluation.json"),
                JsonSerializer.Serialize(new { evaluation_schema_version = 3, model_version = baseline, validation_metrics = new { } }));
            var statePath = Path.Combine(paths.ExtractionProductionRoot, $"{baseline}-state.json");
            var state = JsonNode.Parse(File.ReadAllText(statePath))!.AsObject();
            state["Completed"] = true;
            File.WriteAllText(statePath, state.ToJsonString());
            foreach (var includeSynthetic in new[] { false, true })
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(
                    profile, (_, _) => { }, null, CancellationToken.None, includeSynthetic));
                var candidatePath = Path.Combine(paths.ExtractionProductionRoot, $"{service.ActiveModelVersion}-state.json");
                var candidate = JsonNode.Parse(File.ReadAllText(candidatePath))!.AsObject();
                Assert.Equal(baseline, candidate["BaselineModelVersion"]!.GetValue<string>());
            }
            Assert.Equal("preserved baseline", File.ReadAllText(Path.Combine(paths.ArtifactRoot(baseline), "best.pt")));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task MissingBaselineChainRecoversCompletedArtifactButExcludesCurrentAndIdentityRuns()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-baseline-discovery-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            const string baseline = "extractor-preserved";
            Directory.CreateDirectory(paths.ArtifactRoot(baseline));
            File.WriteAllText(Path.Combine(paths.ArtifactRoot(baseline), "best.pt"), "preserved baseline");
            File.WriteAllText(Path.Combine(paths.ArtifactRoot(baseline), "evaluation.json"),
                JsonSerializer.Serialize(new { evaluation_schema_version = 3, model_version = baseline, validation_metrics = new { } }));
            Directory.CreateDirectory(paths.ArtifactRoot("identity-run"));
            File.WriteAllText(Path.Combine(paths.ArtifactRoot("identity-run"), "best.pt"), "identity");
            File.WriteAllText(Path.Combine(paths.ArtifactRoot("identity-run"), "evaluation.json"), "{}");
            var service = new ExtractionProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var profile = TrainingEnvironmentService.CreateTrainingProfile(0, "Test GPU", 8192);
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(profile, (_, _) => { }, null, CancellationToken.None));
            var statePath = Path.Combine(paths.ExtractionProductionRoot, $"{service.ActiveModelVersion}-state.json");
            var state = JsonNode.Parse(File.ReadAllText(statePath))!.AsObject();
            Assert.Equal(baseline, state["BaselineModelVersion"]!.GetValue<string>());
            var oldVersion = service.ActiveModelVersion;
            state.Remove("CheckpointSelectionPolicy");
            state.Remove("BaselineModelVersion");
            File.WriteAllText(statePath, state.ToJsonString());
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RunAsync(profile, (_, _) => { }, null, CancellationToken.None));
            Assert.NotEqual(oldVersion, service.ActiveModelVersion);
            var fresh = JsonNode.Parse(File.ReadAllText(Path.Combine(paths.ExtractionProductionRoot, $"{service.ActiveModelVersion}-state.json")))!.AsObject();
            Assert.Equal(baseline, fresh["BaselineModelVersion"]!.GetValue<string>());
            Assert.Equal("geometry-guarded-v3", fresh["CheckpointSelectionPolicy"]!.GetValue<string>());
            Assert.Equal("preserved baseline", File.ReadAllText(Path.Combine(paths.ArtifactRoot(baseline), "best.pt")));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ManualDiagnosticRunsUseDistinctOutputFolders()
    {
        var artifactRoot = Path.Combine("artifacts", "extractor-test");

        var first = ExtractionProductionWorkflowService.CreateManualDiagnosticOutputPath(artifactRoot);
        var second = ExtractionProductionWorkflowService.CreateManualDiagnosticOutputPath(artifactRoot);

        Assert.NotEqual(first, second);
        var expectedRoot = Path.Combine(artifactRoot, "diagnostics", "manual") + Path.DirectorySeparatorChar;
        Assert.StartsWith(expectedRoot, first);
        Assert.StartsWith(expectedRoot, second);
    }

    [Fact]
    public void DiagnosticPreviewIsLoadedWithoutLockingItsFile()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-preview-{Guid.NewGuid():N}");
        var imagePath = Path.Combine(root, "overlay.png");
        Directory.CreateDirectory(root);
        try
        {
            var pixels = new byte[] { 0, 80, 180, 255 };
            var source = BitmapSource.Create(1, 1, 96, 96, PixelFormats.Bgra32, null, pixels, 4);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(source));
            using (var stream = File.Create(imagePath)) encoder.Save(stream);

            var preview = ExtractionTrainingViewModel.LoadUnlockedBitmap(imagePath);

            Assert.NotNull(preview);
            Assert.True(preview.IsFrozen);
            using var replacement = new FileStream(imagePath, FileMode.Create, FileAccess.Write, FileShare.None);
            replacement.WriteByte(1);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
