using System.IO;

namespace Deckino.Tools.Services;

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
        SmokeRoot = Path.Combine(TrainingRoot, "smoke");
        CameraRoot = Path.Combine(TrainingRoot, "camera");
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
    public string SmokeRoot { get; }
    public string CameraRoot { get; }
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
}
