using Deckino.Toolbox.Services;
using System.Text.Json.Nodes;

namespace Deckino.Toolbox.Tests;

public sealed class ArtworkProductionStateTests
{
    // A run recorded as trained whose checkpoint is gone (seen on the laptop) reads as ready for a fresh run, with
    // every stage shown, rather than failing with an empty stage list.
    [Fact]
    public void RunWithAMissingCheckpointIsReadyForAFreshRun()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-artwork-state-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            const string version = "artwork-run-20261020T142937422Z";
            Directory.CreateDirectory(paths.ProductionRoot);
            Directory.CreateDirectory(paths.ArtifactRoot(version));
            File.WriteAllText(Path.Combine(paths.ProductionRoot, "active-artwork-model.txt"), version);
            var stages = new JsonObject();
            foreach (var id in new[] { "dataset", "cuda", "evidence_index", "evidence_evaluate", "train", "final_index", "recognize", "export", "verify" })
                stages[id] = new JsonObject { ["id"] = id, ["name"] = id, ["status"] = id == "train" ? "passed" : "pending", ["detail"] = "x" };
            var state = new JsonObject
            {
                ["schema_version"] = 2,
                ["dataset_version"] = IdentityProductionWorkflowService.DatasetVersion,
                ["model_version"] = version,
                ["seed"] = IdentityProductionWorkflowService.Seed,
                ["completed_epoch"] = 3,
                ["stages"] = stages,
            };
            File.WriteAllText(Path.Combine(paths.ProductionRoot, $"{version}-state.json"), state.ToJsonString());

            var service = new IdentityProductionWorkflowService(paths, new PythonProcessRunner(paths), new TrainingResultExporter(paths));
            var snapshot = service.Inspect();

            Assert.Equal(ProductionWorkflowOutcome.Ready, snapshot.Outcome);
            Assert.Contains("files are missing", snapshot.Summary);
            Assert.Equal(9, snapshot.Stages.Count);
            Assert.All(snapshot.Stages, stage => Assert.Equal(ProductionStageStatus.Pending, stage.Status));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
