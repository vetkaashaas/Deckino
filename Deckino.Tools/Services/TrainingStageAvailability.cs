using System.IO;

namespace Deckino.Tools.Services;

public sealed record TrainingStageAvailability(
    bool CanPrepareDataset,
    bool DatasetReady,
    bool CudaSmokeReady,
    bool TrainingReady,
    bool EvaluationReady)
{
    public static TrainingStageAvailability Evaluate(
        TrainingPaths paths,
        string datasetVersion,
        string modelVersion,
        bool packagesReady,
        bool paperCacheReady)
    {
        var datasetReady = File.Exists(paths.ManifestPath(datasetVersion));
        var smokeMarker = Path.Combine(paths.TrainingRoot, "cuda-smoke-v3.ok");
        var smokeReady = datasetReady && File.Exists(smokeMarker)
            && File.ReadAllText(smokeMarker).Trim() == datasetVersion;
        var artifactRoot = paths.ArtifactRoot(modelVersion);
        var trainingReady = File.Exists(Path.Combine(artifactRoot, "best.pt"));
        var evaluationReady = trainingReady
            && File.Exists(Path.Combine(artifactRoot, "thresholds.json"))
            && File.Exists(Path.Combine(artifactRoot, "evaluation.json"));
        return new TrainingStageAvailability(
            packagesReady && paperCacheReady,
            datasetReady,
            smokeReady,
            trainingReady,
            evaluationReady);
    }
}
