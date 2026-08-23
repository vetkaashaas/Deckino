using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class IdentitySmokeTestServiceTests
{
    [Fact]
    public void ResetDeletesOnlyFixedSmokeLocations()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-smoke-reset-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var productionManifest = paths.DatasetRoot("paper-v3");
            var productionArtifact = paths.ArtifactRoot("production-model-v3");
            var results = Path.Combine(paths.TrainingRoot, "results");
            var logs = paths.LogsRoot;
            foreach (var directory in new[]
                     {
                         productionManifest, productionArtifact, results, logs,
                         paths.DatasetRoot(IdentitySmokeTestService.DatasetVersion),
                         paths.ArtifactRoot(IdentitySmokeTestService.ModelVersion), paths.SmokeRoot,
                     })
            {
                Directory.CreateDirectory(directory);
                File.WriteAllText(Path.Combine(directory, "keep-or-delete.txt"), directory);
            }
            var service = new IdentitySmokeTestService(
                paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));

            service.Reset();

            Assert.True(Directory.Exists(productionManifest));
            Assert.True(Directory.Exists(productionArtifact));
            Assert.True(Directory.Exists(results));
            Assert.True(Directory.Exists(logs));
            Assert.False(Directory.Exists(paths.DatasetRoot(IdentitySmokeTestService.DatasetVersion)));
            Assert.False(Directory.Exists(paths.ArtifactRoot(IdentitySmokeTestService.ModelVersion)));
            Assert.False(Directory.Exists(paths.SmokeRoot));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void FreshInspectionReturnsEightPendingStages()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-smoke-inspect-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new IdentitySmokeTestService(
                paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var snapshot = service.Inspect("paper-v3");
            Assert.False(snapshot.Passed);
            Assert.Equal(8, snapshot.Stages.Count);
            Assert.Equal(
                new[] { "subset", "cuda", "epoch1", "resume", "evaluate", "recognize", "export", "verify" },
                snapshot.Stages.Select(stage => stage.Id));
            Assert.All(snapshot.Stages, stage => Assert.Equal(SmokeStageStatus.Pending, stage.Status));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void InspectionStopsWhenRecordedArtifactsAreMissing()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-smoke-inconsistent-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            Directory.CreateDirectory(paths.SmokeRoot);
            File.WriteAllText(
                Path.Combine(paths.SmokeRoot, "identity-smoke-state.json"),
                """
                {
                  "schema_version": 1,
                  "source_dataset_version": "paper-v3",
                  "dataset_version": "paper-smoke20-v3",
                  "model_version": "mobilenetv3s-512-smoke20-v3",
                  "seed": 20260823,
                  "passed": false,
                  "stages": {
                    "subset": {
                      "id": "subset",
                      "name": "20-class subset",
                      "status": "passed",
                      "detail": "Previously passed."
                    }
                  },
                  "logs": []
                }
                """);
            var service = new IdentitySmokeTestService(
                paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));

            var error = Assert.Throws<InvalidOperationException>(() => service.Inspect("paper-v3"));
            Assert.Contains("Reset quick test", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void KnownSampleSelectionUsesFirstCorrectHeldOutClass()
    {
        var ordered = new[] { "oracle-wrong-a", "oracle-correct", "oracle-wrong-b" };
        var incorrect = new HashSet<string>(StringComparer.Ordinal)
        {
            "oracle-wrong-a", "oracle-wrong-b",
        };

        var selected = IdentitySmokeTestService.SelectKnownOracleId(ordered, incorrect);

        Assert.Equal("oracle-correct", selected);
        Assert.Throws<InvalidOperationException>(() =>
            IdentitySmokeTestService.SelectKnownOracleId(ordered, ordered.ToHashSet(StringComparer.Ordinal)));
    }
}
