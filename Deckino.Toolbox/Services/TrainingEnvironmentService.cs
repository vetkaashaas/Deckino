using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using Microsoft.Win32;

namespace Deckino.Toolbox.Services;

public sealed record TrainingReadiness(
    bool HasMinimumDiskSpace,
    double FreeDiskGiB,
    string? PythonPath,
    string? PythonVersion,
    bool VirtualEnvironmentReady,
    bool PackagesReady,
    bool CudaReady,
    string? GpuName,
    string? DriverVersion,
    long? VramMiB,
    string? TorchVersion,
    string? CudaRuntime,
    bool PretrainedWeightsCached,
    int? GpuIndex = null,
    string? GpuProfile = null,
    int? RecommendedBatchSize = null,
    bool ValidatedGpu = false)
{
    public bool Ready => HasMinimumDiskSpace && VirtualEnvironmentReady && PackagesReady
        && CudaReady && PretrainedWeightsCached;
}

public sealed record NvidiaGpuInfo(int Index, string Name, string DriverVersion, long VramMiB);

public sealed record CudaTrainingProfile(
    int DeviceIndex,
    string GpuName,
    long VramMiB,
    int BatchSize,
    bool Validated,
    string Label);

public sealed class TrainingEnvironmentService(
    TrainingPaths paths,
    PythonProcessRunner processRunner,
    HttpClient httpClient)
{
    public const string RequiredCliVersion = "0.12.0";
    public const long MinimumVramMiB = 6000;
    public const string PythonVersion = "3.12.10";
    private static readonly Uri PythonInstallerUri = new(
        "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe");
    private string RuntimeMarkerPath => Path.Combine(paths.RuntimeRoot, "cuda-runtime-v3.marker");

    public static IReadOnlyList<string> BuildPrivatePythonInstallerArguments(string targetDirectory) =>
        ["/quiet", "InstallAllUsers=0", $"TargetDir={targetDirectory}", "PrependPath=0",
            "Include_launcher=0", "Include_test=0", "Include_doc=0", "Include_pip=1",
            "Shortcuts=0", "AssociateFiles=0"];

    public async Task<TrainingReadiness> CheckAsync(
        Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var freeGiB = GetMinimumAvailableFreeGiB();
        var python = await FindPython312Async(cancellationToken);
        var venvReady = File.Exists(paths.VirtualEnvironmentPython);
        var packagesReady = false;
        var cudaReady = false;
        var detectedGpus = await DetectNvidiaGpusAsync(cancellationToken);
        var selectedProfile = SelectTrainingProfile(detectedGpus);
        var selectedGpu = selectedProfile is null
            ? null
            : detectedGpus.First(gpu => gpu.Index == selectedProfile.DeviceIndex);
        string? gpuName = selectedGpu?.Name;
        string? driver = selectedGpu?.DriverVersion;
        long? vram = selectedGpu?.VramMiB;
        string? torch = null;
        string? runtime = null;

        if (venvReady)
        {
            var result = await processRunner.RunAsync(
                paths.VirtualEnvironmentPython,
                ["-m", "deckino_training", "doctor", "--require-cuda", "--minimum-vram-mb", MinimumVramMiB.ToString()],
                "requirements-check",
                onLine,
                cancellationToken);
            var doctor = result.Events.LastOrDefault(item =>
                item.TryGetProperty("event", out var name) && name.GetString() == "doctor");
            if (doctor.ValueKind == JsonValueKind.Object)
            {
                cudaReady = doctor.GetProperty("status").GetString() == "ok";
                torch = doctor.GetProperty("torch").GetString();
                runtime = doctor.GetProperty("cuda_runtime").GetString();
                packagesReady = doctor.GetProperty("cli_version").GetString() == RequiredCliVersion
                    && torch is not null && torch.StartsWith("2.4.1+cu118", StringComparison.Ordinal)
                    && runtime == "11.8";
                driver ??= doctor.TryGetProperty("driver_version", out var driverElement)
                    ? driverElement.GetString()
                    : null;
                if (doctor.TryGetProperty("selected_device", out var device)
                    && device.ValueKind == JsonValueKind.Object)
                {
                    gpuName = device.GetProperty("name").GetString();
                    vram = device.GetProperty("vram_mb").GetInt64();
                    var index = device.GetProperty("index").GetInt32();
                    selectedProfile = CreateTrainingProfile(index, gpuName!, vram.Value);
                }
            }
        }

        return new TrainingReadiness(
            freeGiB >= 15,
            freeGiB,
            python,
            python is null ? null : "3.12 x64",
            venvReady,
            packagesReady,
            cudaReady,
            gpuName,
            driver,
            vram,
            torch,
            runtime,
            Directory.Exists(paths.TorchCacheRoot)
                && Directory.EnumerateFiles(paths.TorchCacheRoot, "*.pth", SearchOption.AllDirectories).Any(),
            selectedProfile?.DeviceIndex,
            selectedProfile?.Label,
            selectedProfile?.BatchSize,
            selectedProfile?.Validated ?? false);
    }

    public static IReadOnlyList<NvidiaGpuInfo> ParseNvidiaSmiOutput(string output)
    {
        var result = new List<NvidiaGpuInfo>();
        foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var fields = line.Split(',', StringSplitOptions.TrimEntries);
            if (fields.Length == 4
                && int.TryParse(fields[0], out var index)
                && long.TryParse(fields[3], out var vramMiB))
            {
                result.Add(new NvidiaGpuInfo(index, fields[1], fields[2], vramMiB));
            }
        }
        return result;
    }

    public static CudaTrainingProfile? SelectTrainingProfile(IEnumerable<NvidiaGpuInfo> adapters)
    {
        var selected = adapters
            .Where(adapter => adapter.VramMiB >= MinimumVramMiB)
            .OrderByDescending(adapter => adapter.VramMiB)
            .ThenBy(adapter => adapter.Index)
            .FirstOrDefault();
        return selected is null
            ? null
            : CreateTrainingProfile(selected.Index, selected.Name, selected.VramMiB);
    }

    public static CudaTrainingProfile CreateTrainingProfile(int index, string name, long vramMiB)
    {
        var validated = name.Contains("RTX 3060 Laptop", StringComparison.OrdinalIgnoreCase)
            || name.Contains("RTX 4070 Laptop", StringComparison.OrdinalIgnoreCase);
        var batchSize = vramMiB >= 7680 ? 64 : 32;
        var label = validated
            ? $"Validated {batchSize}-batch profile"
            : $"Compatible unvalidated {batchSize}-batch profile";
        return new CudaTrainingProfile(index, name, vramMiB, batchSize, validated, label);
    }

    private static async Task<IReadOnlyList<NvidiaGpuInfo>> DetectNvidiaGpusAsync(
        CancellationToken cancellationToken)
    {
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var candidates = new[]
        {
            "nvidia-smi.exe",
            Path.Combine(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
        };
        foreach (var executable in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = executable,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                startInfo.ArgumentList.Add("--query-gpu=index,name,driver_version,memory.total");
                startInfo.ArgumentList.Add("--format=csv,noheader,nounits");
                using var process = Process.Start(startInfo);
                if (process is null) continue;
                var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
                await process.WaitForExitAsync(cancellationToken);
                if (process.ExitCode == 0)
                {
                    return ParseNvidiaSmiOutput(output);
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
            }
        }
        return [];
    }

    public async Task InstallAsync(
        bool allowPrivatePythonInstall,
        Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(paths.RuntimeRoot);
        if (GetMinimumAvailableFreeGiB() < 15)
        {
            throw new InvalidOperationException("At least 15 GiB of free disk space is required; 20 GiB is recommended.");
        }
        var python = await FindPython312Async(cancellationToken);
        if (python is null)
        {
            if (!allowPrivatePythonInstall)
            {
                throw new InvalidOperationException("Python 3.12 x64 is not installed and private installation was not approved.");
            }
            python = await InstallPrivatePythonAsync(onLine, cancellationToken);
        }
        if (Directory.Exists(paths.VirtualEnvironmentRoot) && !File.Exists(RuntimeMarkerPath))
        {
            Directory.Delete(paths.VirtualEnvironmentRoot, recursive: true);
        }
        if (!File.Exists(paths.VirtualEnvironmentPython))
        {
            await EnsureSuccessAsync(await processRunner.RunAsync(
                python,
                ["-m", "venv", paths.VirtualEnvironmentRoot],
                "runtime-create",
                onLine,
                cancellationToken), "Creating the virtual environment");
        }
        await EnsureSuccessAsync(await processRunner.RunAsync(
            paths.VirtualEnvironmentPython,
            ["-m", "pip", "install", "--no-cache-dir", "-r", paths.RequirementsPath],
            "packages-install",
            onLine,
            cancellationToken), "Installing CUDA packages");
        await EnsureSuccessAsync(await processRunner.RunAsync(
            paths.VirtualEnvironmentPython,
            ["-m", "pip", "install", "--no-cache-dir", "--no-deps", "--force-reinstall", paths.BundledProjectRoot],
            "deckino-training-install",
            onLine,
            cancellationToken), "Installing Deckino training CLI");
        await EnsureSuccessAsync(await processRunner.RunAsync(
            paths.VirtualEnvironmentPython,
            ["-m", "deckino_training", "cache-backbone"],
            "backbone-cache",
            onLine,
            cancellationToken), "Caching pretrained weights");
        File.WriteAllText(RuntimeMarkerPath, "schema=3\nbackend=cuda\n");
    }

    private async Task<string?> FindPython312Async(CancellationToken cancellationToken)
    {
        var candidates = new List<string> { paths.PrivatePython };
        candidates.AddRange(GetRegisteredPythonExecutables().Where(File.Exists));
        candidates.AddRange(["py.exe", "python.exe"]);
        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var arguments = candidate.EndsWith("py.exe", StringComparison.OrdinalIgnoreCase)
                ? new[] { "-3.12", "-c", "import platform,sys;print(sys.executable);print(platform.architecture()[0]);print(sys.version_info[:2])" }
                : new[] { "-c", "import platform,sys;print(sys.executable);print(platform.architecture()[0]);print(sys.version_info[:2])" };
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = candidate,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                foreach (var argument in arguments)
                {
                    startInfo.ArgumentList.Add(argument);
                }
                using var process = Process.Start(startInfo);
                if (process is null)
                {
                    continue;
                }
                var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
                await process.WaitForExitAsync(cancellationToken);
                var lines = output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
                if (process.ExitCode == 0 && lines.Length >= 3
                    && lines[1] == "64bit" && lines[2].Contains("(3, 12)"))
                {
                    return lines[0];
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
            }
        }
        return null;
    }

    private async Task<string> InstallPrivatePythonAsync(
        Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken)
    {
        var downloads = Path.Combine(paths.RuntimeRoot, "downloads");
        Directory.CreateDirectory(downloads);
        var installer = Path.Combine(downloads, $"python-{PythonVersion}-amd64.exe");
        if (!File.Exists(installer))
        {
            var partialInstaller = installer + ".download";
            using var response = await httpClient.GetAsync(PythonInstallerUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using (var destination = File.Create(partialInstaller))
            {
                await source.CopyToAsync(destination, cancellationToken);
            }
            File.Move(partialInstaller, installer, overwrite: true);
        }
        await EnsureSuccessAsync(await processRunner.RunAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                paths.SignatureVerifierPath, "-InstallerPath", installer],
            "python-signature-check",
            onLine,
            cancellationToken), "Verifying the Python installer signature");
        var installLogs = Path.Combine(paths.TrainingRoot, "install-logs");
        Directory.CreateDirectory(installLogs);
        var staleDeckinoRegistration = GetRegisteredPythonExecutables()
            .FirstOrDefault(path => !File.Exists(path) && IsDeckinoOwnedPythonPath(path));
        if (staleDeckinoRegistration is not null)
        {
            onLine(
                $"A deleted Deckino Python runtime is still registered at {staleDeckinoRegistration}. Repairing it before removal…",
                null);
            var repairLog = Path.Combine(
                installLogs,
                $"python-{PythonVersion}-stale-repair-{DateTime.UtcNow:yyyyMMdd-HHmmss}.log");
            await EnsureSuccessAsync(await processRunner.RunAsync(
                installer,
                ["/repair", "/quiet", "/log", repairLog],
                "python-stale-runtime-repair",
                onLine,
                cancellationToken), "Repairing the deleted Deckino Python runtime before removal");

            var uninstallLog = Path.Combine(
                installLogs,
                $"python-{PythonVersion}-stale-uninstall-{DateTime.UtcNow:yyyyMMdd-HHmmss}.log");
            await EnsureSuccessAsync(await processRunner.RunAsync(
                installer,
                ["/uninstall", "/quiet", "/log", uninstallLog],
                "python-stale-runtime-uninstall",
                onLine,
                cancellationToken), "Removing the stale Deckino Python registration");
            onLine("The stale Deckino Python registration was removed. Installing the persistent runtime…", null);
        }
        Directory.CreateDirectory(Path.GetDirectoryName(paths.PrivatePython)!);
        var installerLog = Path.Combine(
            installLogs,
            $"python-{PythonVersion}-install-{DateTime.UtcNow:yyyyMMdd-HHmmss}.log");
        var installerArguments = BuildPrivatePythonInstallerArguments(
            Path.GetDirectoryName(paths.PrivatePython)!).ToList();
        installerArguments.InsertRange(1, ["/log", installerLog]);
        await EnsureSuccessAsync(await processRunner.RunAsync(
            installer,
            installerArguments,
            "python-private-install",
            onLine,
            cancellationToken), "Installing private Python");
        for (var attempt = 0; attempt < 20 && !File.Exists(paths.PrivatePython); attempt++)
        {
            await Task.Delay(500, cancellationToken);
        }
        if (!File.Exists(paths.PrivatePython))
        {
            throw new InvalidOperationException(
                $"Python installer completed without creating the private runtime. Installer log: {installerLog}");
        }
        return paths.PrivatePython;
    }

    private static IReadOnlyList<string> GetRegisteredPythonExecutables()
    {
        var result = new List<string>();
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
                using var pythonCore = baseKey.OpenSubKey(@"SOFTWARE\Python\PythonCore");
                if (pythonCore is null) continue;
                foreach (var version in pythonCore.GetSubKeyNames()
                             .Where(name => name.StartsWith("3.12", StringComparison.OrdinalIgnoreCase)))
                {
                    using var installPath = pythonCore.OpenSubKey($@"{version}\InstallPath");
                    var executable = installPath?.GetValue("ExecutablePath") as string;
                    var directory = installPath?.GetValue(null) as string;
                    if (string.IsNullOrWhiteSpace(executable) && !string.IsNullOrWhiteSpace(directory))
                    {
                        executable = Path.Combine(directory, "python.exe");
                    }
                    if (!string.IsNullOrWhiteSpace(executable)) result.Add(executable);
                }
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
        return result;
    }

    private static bool IsDeckinoOwnedPythonPath(string path)
    {
        var normalized = path.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        return normalized.Contains(
            $"{Path.DirectorySeparatorChar}data{Path.DirectorySeparatorChar}training{Path.DirectorySeparatorChar}runtime{Path.DirectorySeparatorChar}python312{Path.DirectorySeparatorChar}",
            StringComparison.OrdinalIgnoreCase)
            || normalized.Contains(
                $"{Path.DirectorySeparatorChar}Deckino{Path.DirectorySeparatorChar}training-runtime-v3{Path.DirectorySeparatorChar}python312{Path.DirectorySeparatorChar}",
                StringComparison.OrdinalIgnoreCase);
    }

    private double GetMinimumAvailableFreeGiB()
    {
        var roots = new[] { paths.DataRoot, paths.RuntimeRoot }
            .Select(Path.GetPathRoot)
            .Where(root => !string.IsNullOrWhiteSpace(root))
            .Distinct(StringComparer.OrdinalIgnoreCase);
        return roots.Min(root => new DriveInfo(root!).AvailableFreeSpace / 1024d / 1024d / 1024d);
    }

    private static Task EnsureSuccessAsync(PythonRunResult result, string operation)
    {
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"{operation} failed with exit code {result.ExitCode}. See {result.LogPath}");
        }
        return Task.CompletedTask;
    }
}
