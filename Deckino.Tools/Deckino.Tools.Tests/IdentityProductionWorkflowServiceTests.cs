using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class IdentityProductionWorkflowServiceTests
{
    [Fact]
    public void EmptyWorkflowExposesNineOrderedArtworkStages()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-production-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new IdentityProductionWorkflowService(
                paths,
                new PythonProcessRunner(paths),
                new TrainingResultExporter(paths));

            var snapshot = service.Inspect();

            Assert.Equal(ProductionWorkflowOutcome.Ready, snapshot.Outcome);
            Assert.Equal(IdentityProductionWorkflowService.DatasetVersion, snapshot.DatasetVersion);
            Assert.Equal(IdentityProductionWorkflowService.InitialModelVersion, snapshot.ModelVersion);
            Assert.Equal(9, snapshot.Stages.Count);
            Assert.Equal(
                ["dataset", "cuda", "evidence_index", "evidence_evaluate", "train", "final_index", "recognize", "export", "verify"],
                snapshot.Stages.Select(stage => stage.Id));
            Assert.All(snapshot.Stages, stage => Assert.Equal(ProductionStageStatus.Pending, stage.Status));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void NewVersionCannotAbandonAnIncompleteRun()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-production-version-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var service = new IdentityProductionWorkflowService(
                paths,
                new PythonProcessRunner(paths),
                new TrainingResultExporter(paths));

            var error = Assert.Throws<InvalidOperationException>(service.StartNewModelVersion);

            Assert.Contains("Finish the active production run", error.Message, StringComparison.Ordinal);
            Assert.False(File.Exists(service.ActiveModelPath));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(64, 32)]
    [InlineData(32, 16)]
    [InlineData(16, 16)]
    public void OomFallbackUsesTheNextSafeBatch(int current, int expected)
    {
        Assert.Equal(expected, IdentityProductionWorkflowService.NextLowerBatch(current));
    }

    [Fact]
    public void MissingPriorCheckpointSelectsCleanInstallTraining()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-bootstrap-{Guid.NewGuid():N}");
        var checkpoint = Path.Combine(root, "best.pt");
        try
        {
            Assert.True(IdentityProductionWorkflowService.RequiresBootstrapTraining(checkpoint));

            Directory.CreateDirectory(root);
            File.WriteAllText(checkpoint, "checkpoint");

            Assert.False(IdentityProductionWorkflowService.RequiresBootstrapTraining(checkpoint));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
