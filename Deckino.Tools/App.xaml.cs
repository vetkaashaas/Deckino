using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Windows;
using Deckino.Tools.Data;
using Deckino.Tools.Services;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools;

public partial class App : Application
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (e.Args.Any(a => a.Equals("--sync", StringComparison.OrdinalIgnoreCase)))
        {
            AttachConsole(-1);
            RunHeadlessBulkSync();
            Shutdown();
            return;
        }

        if (e.Args.Any(a => a.Equals("--sync-art", StringComparison.OrdinalIgnoreCase)))
        {
            AttachConsole(-1);
            RunHeadlessArtSync();
            Shutdown();
            return;
        }

        var database = new Database(Database.ResolveDefaultPath());
        database.Initialize();

        var options = new SyncOptions
        {
            DataRoot = Path.GetDirectoryName(database.DefaultPath)!,
        };
        var client = new ScryfallClient(options.RequestIntervalMs);
        var coordinator = new WorkspaceOperationCoordinator();
        var syncViewModel = new SyncViewModel(
            database,
            new BulkDataSyncService(database, client, options),
            new ArtCropDownloadService(database, client, options),
            coordinator);
        _ = syncViewModel.RefreshCountsAsync();

        var trainingPaths = new TrainingPaths(options.DataRoot);
        var pythonRunner = new PythonProcessRunner(trainingPaths);
        var trainingEnvironment = new TrainingEnvironmentService(
            trainingPaths,
            pythonRunner,
            new HttpClient());
        var runnerViewModel = new RunnerViewModel(
            database,
            trainingPaths,
            trainingEnvironment,
            pythonRunner,
            new TrainingResultExporter(trainingPaths),
            coordinator);

        var window = new MainWindow
        {
            DataContext = new ShellViewModel(
                syncViewModel,
                new AnnotatorViewModel(),
                runnerViewModel),
        };
        window.Show();
    }

    private void RunHeadlessArtSync()
    {
        Console.WriteLine("runner: starting");
        var database = new Database(Database.ResolveDefaultPath());
        database.Initialize();
        var options = new SyncOptions
        {
            DataRoot = Path.GetDirectoryName(database.DefaultPath)!,
        };
        using var client = new ScryfallClient(options.RequestIntervalMs);
        var service = new ArtCropDownloadService(database, client, options);
        Console.WriteLine("runner: services ready");
        var result = Task.Run(() =>
        {
            var lastWrite = -1L;
            var progress = new Progress<ArtSyncStatus>(status =>
            {
                if (status.Done == Interlocked.Read(ref lastWrite))
                {
                    return;
                }
                Interlocked.Exchange(ref lastWrite, status.Done);
                var line = $"{DateTime.UtcNow:HH:mm:ss} art: {status.Done:N0} done, {status.Failed:N0} failed, {status.Pending:N0} pending";
                Console.WriteLine(line);
            });
            return service.RunPendingAsync(progress, CancellationToken.None);
        }).GetAwaiter().GetResult();
        Console.WriteLine("runner: sync returned");
    }

    private void RunHeadlessBulkSync()
    {
        var database = new Database(Database.ResolveDefaultPath());
        database.Initialize();
        var options = new SyncOptions
        {
            DataRoot = Path.GetDirectoryName(database.DefaultPath)!,
        };
        var summary = Task.Run(() =>
        {
            using var client = new ScryfallClient(options.RequestIntervalMs);
            var service = new BulkDataSyncService(database, client, options);
            var logPath = Path.Combine(options.DataRoot, "bulk-sync.log");
            var lastWrite = -1L;
            var progress = new Progress<BulkSyncStatus>(status =>
            {
                if (status.Processed == Interlocked.Read(ref lastWrite))
                {
                    return;
                }
                Interlocked.Exchange(ref lastWrite, status.Processed);
                var line = $"{DateTime.UtcNow:HH:mm:ss} {status.Stage}: {status.Processed:N0}"
                           + (status.Total is { } total ? $" / {total:N0}" : string.Empty);
                Console.WriteLine(line);
                File.AppendAllText(logPath, line + Environment.NewLine);
            });
            try
            {
                var result = service.SyncAllAsync(progress, CancellationToken.None).GetAwaiter().GetResult();
                return $"done: {result.CardsImported:N0} cards ({result.SetsUpserted} sets), "
                       + $"{result.OracleCardsImported:N0} oracle cards, no-art={result.NoArtCount}, "
                       + $"up-to-date=[{string.Join(", ", result.SkippedUpToDate)}]";
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"FAILED: {ex}");
                File.AppendAllText(logPath, $"FAILED: {ex}" + Environment.NewLine);
                Environment.ExitCode = 1;
                return "FAILED";
            }
        }).GetAwaiter().GetResult();

        Console.WriteLine(summary);
        File.AppendAllText(Path.Combine(options.DataRoot, "bulk-sync.log"), summary + Environment.NewLine);
    }
}
