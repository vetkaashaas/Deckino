using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class TrainingEnvironmentServiceTests
{
    [Fact]
    public void ParsesAllNvidiaAdaptersWithoutAssumingGpuZero()
    {
        const string output = "0, NVIDIA RTX A1000 Laptop GPU, 555.10, 4096\n"
            + "1, NVIDIA GeForce RTX 4070 Laptop GPU, 560.00, 8188\n";

        var adapters = TrainingEnvironmentService.ParseNvidiaSmiOutput(output);
        var trainingGpu = TrainingEnvironmentService.SelectTrainingProfile(adapters)!;

        Assert.Equal(2, adapters.Count);
        Assert.Equal(8188, trainingGpu.VramMiB);
        Assert.Equal(1, trainingGpu.DeviceIndex);
        Assert.Equal(64, trainingGpu.BatchSize);
        Assert.True(trainingGpu.Validated);
    }

    [Fact]
    public void UsesBatch32ForSixGigabyteGpuAndRejectsSmallerAdapters()
    {
        var profile = TrainingEnvironmentService.SelectTrainingProfile(
        [
            new NvidiaGpuInfo(0, "NVIDIA GeForce GTX 1650 SUPER", "560.00", 4096),
            new NvidiaGpuInfo(1, "NVIDIA GeForce RTX 3060 Laptop GPU", "560.00", 6144),
        ]);

        Assert.NotNull(profile);
        Assert.Equal(1, profile.DeviceIndex);
        Assert.Equal(32, profile.BatchSize);
        Assert.True(profile.Validated);
        Assert.Null(TrainingEnvironmentService.SelectTrainingProfile(
            [new NvidiaGpuInfo(0, "NVIDIA GeForce GTX 1650 SUPER", "560.00", 4096)]));
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
