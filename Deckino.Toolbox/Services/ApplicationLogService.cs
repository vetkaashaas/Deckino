using System.Globalization;
using System.IO;
using System.Text;

namespace Deckino.Toolbox.Services;

public sealed class ApplicationLogService
{
    private readonly Lock _writeLock = new();

    public ApplicationLogService(string logsRoot)
    {
        LogsRoot = Path.GetFullPath(logsRoot);
        CurrentLogPath = Path.Combine(LogsRoot, $"deckino-tools-{DateTime.UtcNow:yyyyMMdd}.log");
    }

    public string LogsRoot { get; }
    public string CurrentLogPath { get; }

    public void Information(string area, string message) => Write("INFO", area, message);

    public void Error(string area, string message, Exception? exception = null)
    {
        var detail = exception is null ? message : $"{message}{Environment.NewLine}{exception}";
        Write("ERROR", area, detail);
    }

    public void ClearCurrentLog()
    {
        lock (_writeLock)
        {
            Directory.CreateDirectory(LogsRoot);
            File.WriteAllText(CurrentLogPath, string.Empty, new UTF8Encoding(false));
        }
    }

    private void Write(string level, string area, string message)
    {
        try
        {
            var entry = string.Create(
                CultureInfo.InvariantCulture,
                $"[{DateTime.UtcNow:O}] [{level}] [{area}] {message}{Environment.NewLine}");
            lock (_writeLock)
            {
                Directory.CreateDirectory(LogsRoot);
                File.AppendAllText(CurrentLogPath, entry, new UTF8Encoding(false));
            }
        }
        catch
        {
            // Logging must never prevent the application from opening or shutting down.
        }
    }
}
