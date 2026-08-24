using Deckino.Tools.Services;

namespace Deckino.Tools.Tests;

public sealed class ApplicationLogServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "deckino-application-log-tests",
        Guid.NewGuid().ToString("N"));

    [Fact]
    public void WritesStartupActivityAndExceptionsImmediately()
    {
        var logger = new ApplicationLogService(_root);

        logger.Information("startup", "Main window shown.");
        logger.Error("training", "Training failed.", new InvalidOperationException("checkpoint mismatch"));

        var contents = File.ReadAllText(logger.CurrentLogPath);
        Assert.Contains("[INFO] [startup] Main window shown.", contents);
        Assert.Contains("[ERROR] [training] Training failed.", contents);
        Assert.Contains("checkpoint mismatch", contents);
        Assert.StartsWith(Path.GetFullPath(_root), logger.CurrentLogPath, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ClearCurrentLogTruncatesOnlyTheCurrentApplicationLog()
    {
        var logger = new ApplicationLogService(_root);
        var historicalLog = Path.Combine(_root, "deckino-tools-20000101.log");
        Directory.CreateDirectory(_root);
        File.WriteAllText(historicalLog, "preserve me");
        logger.Information("training", "remove me");

        logger.ClearCurrentLog();

        Assert.Empty(File.ReadAllText(logger.CurrentLogPath));
        Assert.Equal("preserve me", File.ReadAllText(historicalLog));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
