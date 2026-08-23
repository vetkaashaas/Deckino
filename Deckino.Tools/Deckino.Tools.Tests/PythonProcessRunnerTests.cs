using System.Diagnostics;
using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class PythonProcessRunnerTests
{
    [Fact]
    public async Task ParsesJsonLinesAndPersistsTheCompleteLog()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-runner-{Guid.NewGuid():N}");
        try
        {
            var runner = new PythonProcessRunner(new TrainingPaths(root));
            var result = await runner.RunAsync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.WriteLine('{\"event\":\"progress\",\"value\":2}')"],
                "json-lines",
                (_, _) => { },
                CancellationToken.None);

            Assert.Equal(0, result.ExitCode);
            Assert.Single(result.Events);
            Assert.Equal("progress", result.Events[0].GetProperty("event").GetString());
            Assert.Contains("\"value\":2", await File.ReadAllTextAsync(result.LogPath));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task PrefersTheBundledCliSourceOverThePersistentInstalledWheel()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-runner-source-{Guid.NewGuid():N}");
        try
        {
            var paths = new TrainingPaths(root);
            var runner = new PythonProcessRunner(paths);
            var result = await runner.RunAsync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.WriteLine($env:PYTHONPATH)"],
                "bundled-source",
                (_, _) => { },
                CancellationToken.None);

            Assert.Equal(0, result.ExitCode);
            Assert.Contains(paths.BundledSourceRoot, await File.ReadAllTextAsync(result.LogPath),
                StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CancellationTerminatesTheChildProcessTreePromptly()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-cancel-{Guid.NewGuid():N}");
        try
        {
            var runner = new PythonProcessRunner(new TrainingPaths(root));
            using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
            var stopwatch = Stopwatch.StartNew();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => runner.RunAsync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
                "cancellation",
                (_, _) => { },
                cancellation.Token));

            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
