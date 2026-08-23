using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class TrainingStageAvailabilityTests
{
    [Fact]
    public void UnlocksStagesOnlyWhenTheirArtifactsExist()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-stages-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var initial = TrainingStageAvailability.Evaluate(paths, "dataset-v3", "model-v3", true, true);
            Assert.True(initial.CanPrepareDataset);
            Assert.False(initial.DatasetReady);

            Directory.CreateDirectory(paths.DatasetRoot("dataset-v3"));
            File.WriteAllText(paths.ManifestPath("dataset-v3"), "record");
            Directory.CreateDirectory(paths.TrainingRoot);
            File.WriteAllText(Path.Combine(paths.TrainingRoot, "cuda-smoke-v3.ok"), "dataset-v3");
            Directory.CreateDirectory(paths.ArtifactRoot("model-v3"));
            File.WriteAllText(Path.Combine(paths.ArtifactRoot("model-v3"), "best.pt"), "checkpoint");
            File.WriteAllText(Path.Combine(paths.ArtifactRoot("model-v3"), "thresholds.json"), "{}");
            File.WriteAllText(Path.Combine(paths.ArtifactRoot("model-v3"), "evaluation.json"), "{}");

            var complete = TrainingStageAvailability.Evaluate(paths, "dataset-v3", "model-v3", true, true);
            Assert.True(complete.DatasetReady);
            Assert.True(complete.CudaSmokeReady);
            Assert.True(complete.TrainingReady);
            Assert.True(complete.EvaluationReady);
            Assert.False(TrainingStageAvailability.Evaluate(paths, "dataset-v3", "model-v3", true, false).CanPrepareDataset);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
