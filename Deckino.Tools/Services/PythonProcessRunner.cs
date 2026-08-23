using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Deckino.Tools.Services;

public sealed record PythonRunResult(int ExitCode, IReadOnlyList<JsonElement> Events, string LogPath);

public sealed class PythonProcessRunner(TrainingPaths paths)
{
    public async Task<PythonRunResult> RunAsync(
        string executable,
        IReadOnlyList<string> arguments,
        string logName,
        Action<string, JsonElement?> onLine,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, string?>? environment = null)
    {
        Directory.CreateDirectory(paths.LogsRoot);
        var safeName = string.Concat(logName.Select(character =>
            Path.GetInvalidFileNameChars().Contains(character) ? '_' : character));
        var logPath = Path.Combine(
            paths.LogsRoot,
            $"{DateTime.UtcNow:yyyyMMdd-HHmmss}-{safeName}.log");
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = paths.DataRoot,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        startInfo.Environment["PYTHONUTF8"] = "1";
        startInfo.Environment["PYTHONUNBUFFERED"] = "1";
        startInfo.Environment["TORCH_HOME"] = paths.TorchCacheRoot;
        // The CUDA environment intentionally survives portable app replacements. Always
        // load Deckino's CLI from this app build so an older installed wheel cannot win.
        startInfo.Environment["PYTHONPATH"] = paths.BundledSourceRoot;
        startInfo.Environment["DECKINO_CUDA_DEVICE_NAME"] = TrainingEnvironmentService.ExpectedGpu;
        if (environment is not null)
        {
            foreach (var pair in environment)
            {
                startInfo.Environment[pair.Key] = pair.Value;
            }
        }

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException($"Failed to start {executable}.");
        }
        using var registration = cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (InvalidOperationException)
            {
            }
        });

        var events = new List<JsonElement>();
        await using var log = new StreamWriter(logPath, append: false, Encoding.UTF8);
        var sync = new object();
        async Task DrainAsync(StreamReader reader, string streamName)
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                JsonElement? parsed = null;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    parsed = document.RootElement.Clone();
                    lock (sync)
                    {
                        events.Add(parsed.Value);
                    }
                }
                catch (JsonException)
                {
                }
                lock (sync)
                {
                    log.WriteLine($"[{DateTime.UtcNow:O}] [{streamName}] {line}");
                    log.Flush();
                }
                onLine(line, parsed);
            }
        }

        var stdout = DrainAsync(process.StandardOutput, "stdout");
        var stderr = DrainAsync(process.StandardError, "stderr");
        await process.WaitForExitAsync(CancellationToken.None);
        await Task.WhenAll(stdout, stderr);
        cancellationToken.ThrowIfCancellationRequested();
        return new PythonRunResult(process.ExitCode, events, logPath);
    }
}
