using System.IO;

namespace Deckino.Toolbox.Services;

public sealed class TrainingPaths
{
    public TrainingPaths(string dataRoot)
    {
        DataRoot = Path.GetFullPath(dataRoot);
        TrainingRoot = Path.Combine(DataRoot, "training");
        RuntimeRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Deckino",
            "training-runtime-v3");
        VirtualEnvironmentRoot = Path.Combine(RuntimeRoot, "venv");
        LogsRoot = Path.Combine(TrainingRoot, "logs");
        ArtifactsRoot = Path.Combine(TrainingRoot, "artifacts");
        HandoffRoot = Path.Combine(TrainingRoot, "handoff");
        IncomingRoot = Path.Combine(TrainingRoot, "incoming");
        CurrentExtractionPointerPath = Path.Combine(TrainingRoot, "current-extraction.json");
        ProductionRoot = Path.Combine(TrainingRoot, "production");
        CameraRoot = Path.Combine(TrainingRoot, "camera");
        CameraImportsRoot = Path.Combine(CameraRoot, "imports");
        ExtractionRoot = Path.Combine(TrainingRoot, "extraction");
        ExtractionFullCardsRoot = Path.Combine(ExtractionRoot, "full-cards");
        ExtractionProductionRoot = Path.Combine(ProductionRoot, "extraction");
        ExportsRoot = Path.Combine(DataRoot, "exports");
        TorchCacheRoot = Path.Combine(RuntimeRoot, "torch-cache");
        BundledProjectRoot = Path.Combine(AppContext.BaseDirectory, "training");
    }

    public string DataRoot { get; }
    public string TrainingRoot { get; }
    public string RuntimeRoot { get; }
    public string VirtualEnvironmentRoot { get; }
    public string LogsRoot { get; }
    public string ArtifactsRoot { get; }
    public string HandoffRoot { get; }
    public string IncomingRoot { get; }
    public string CurrentExtractionPointerPath { get; }
    public string ProductionRoot { get; }
    public string CameraRoot { get; }
    public string CameraImportsRoot { get; }
    public string ExtractionRoot { get; }
    public string ExtractionFullCardsRoot { get; }
    public string ExtractionProductionRoot { get; }
    public string ExportsRoot { get; }
    public string TorchCacheRoot { get; }
    public string BundledProjectRoot { get; }
    public string BundledSourceRoot => Path.Combine(BundledProjectRoot, "src");
    public string VirtualEnvironmentPython => Path.Combine(VirtualEnvironmentRoot, "Scripts", "python.exe");
    public string RequirementsPath => Path.Combine(BundledProjectRoot, "requirements-cuda.txt");
    public string SignatureVerifierPath => Path.Combine(
        AppContext.BaseDirectory, "training", "runtime-tools", "verify-python-signature.ps1");
    public string PrivatePython => Path.Combine(RuntimeRoot, "python312", "python.exe");

    public string DatasetRoot(string version) => Path.Combine(ExportsRoot, version);
    public string ManifestPath(string version) => Path.Combine(DatasetRoot(version), "manifest.jsonl");
    public string ArtifactRoot(string version) => Path.Combine(ArtifactsRoot, version);

    public string RelativeToDataRoot(string fullPath)
    {
        var relative = Path.GetRelativePath(DataRoot, Path.GetFullPath(fullPath));
        return relative.Replace('\\', '/');
    }
}
