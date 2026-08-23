using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class TrainingEnvironmentServiceTests
{
    [Fact]
    public void ParsesAllNvidiaAdaptersWithoutAssumingGpuZero()
    {
        const string output = "NVIDIA RTX A1000 Laptop GPU, 555.10, 4096\n"
            + "NVIDIA GeForce RTX 4070 Laptop GPU, 560.00, 8188\n";

        var adapters = TrainingEnvironmentService.ParseNvidiaSmiOutput(output);
        var trainingGpu = adapters.Single(adapter =>
            adapter.Name.Contains(TrainingEnvironmentService.ExpectedGpu, StringComparison.OrdinalIgnoreCase));

        Assert.Equal(2, adapters.Count);
        Assert.Equal(8188, trainingGpu.VramMiB);
        Assert.Equal("560.00", trainingGpu.DriverVersion);
    }

    [Fact]
    public void ReadinessRequiresDiskVenvPinnedPackagesCudaAndWeights()
    {
        var missingPython = new TrainingReadiness(
            true, 20, null, null, false, false, false, null, null, null, null, null, false);
        var ready = new TrainingReadiness(
            true, 20, "python.exe", "3.12 x64", true, true, true,
            "NVIDIA GeForce RTX 4070 Laptop GPU", "560.00", 8192,
            "2.4.1+cu118", "11.8", true);

        Assert.False(missingPython.Ready);
        Assert.True(ready.Ready);
        Assert.False((ready with { PretrainedWeightsCached = false }).Ready);
    }

    [Fact]
    public void PrivatePythonInstallIsLocalAndDoesNotModifyPathOrShortcuts()
    {
        var target = @"D:\Deckino\data\training\runtime\python312";

        var arguments = TrainingEnvironmentService.BuildPrivatePythonInstallerArguments(target);

        Assert.Contains($"TargetDir={target}", arguments);
        Assert.Contains("InstallAllUsers=0", arguments);
        Assert.Contains("PrependPath=0", arguments);
        Assert.Contains("Shortcuts=0", arguments);
        Assert.Contains("Include_launcher=0", arguments);
        Assert.DoesNotContain(arguments, argument => argument.Contains("/passive", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void TrainingRuntimeSurvivesReplacingThePortableApplicationFolder()
    {
        var first = new TrainingPaths(@"D:\DeckinoPortableOne\data");
        var second = new TrainingPaths(@"E:\DeckinoPortableTwo\data");

        Assert.Equal(first.RuntimeRoot, second.RuntimeRoot);
        Assert.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            first.RuntimeRoot,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(first.DataRoot, first.RuntimeRoot, StringComparison.OrdinalIgnoreCase);
    }
}
