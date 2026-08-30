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
    private ApplicationLogService? _applicationLog;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var trainingPaths = new TrainingPaths(Database.ResolveDataRoot());
        _applicationLog = new ApplicationLogService(trainingPaths.LogsRoot);
        RegisterApplicationLogging();
        _applicationLog.Information(
            "startup",
            $"Deckino.Tools starting. PID={Environment.ProcessId}; base={AppContext.BaseDirectory}; arguments={string.Join(' ', e.Args)}");

        try
        {
            if (e.Args.Any(a => a.Equals("--sync", StringComparison.OrdinalIgnoreCase)))
            {
                AttachConsole(-1);
                _applicationLog.Information("headless-sync", "Bulk Scryfall sync started.");
                RunHeadlessBulkSync();
                _applicationLog.Information("headless-sync", "Bulk Scryfall sync finished.");
                Shutdown();
                return;
            }

            if (e.Args.Any(a => a.Equals("--sync-art", StringComparison.OrdinalIgnoreCase)))
            {
                AttachConsole(-1);
                _applicationLog.Information("headless-art", "Art download started.");
                RunHeadlessArtSync();
                _applicationLog.Information("headless-art", "Art download finished.");
                Shutdown();
                return;
            }

            StartDesktopApplication(trainingPaths);
        }
        catch (Exception error)
        {
            _applicationLog.Error("startup", "Deckino.Tools failed before the main window opened.", error);
            MessageBox.Show(
                $"Deckino.Tools could not start. The complete error was written to:\n\n{_applicationLog.CurrentLogPath}",
                "Deckino.Tools startup failed",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private void StartDesktopApplication(TrainingPaths trainingPaths)
    {
        var database = new Database(Database.ResolveDefaultPath());
        database.Initialize();
        _applicationLog!.Information("startup", "Database initialized.");

        var options = new SyncOptions
        {
            DataRoot = Path.GetDirectoryName(database.DefaultPath)!,
        };
        var client = new ScryfallClient(options.RequestIntervalMs);
        var coordinator = new WorkspaceOperationCoordinator();
        var cameraStore = new CameraAnnotationStore(trainingPaths);
        var cameraImporter = new CameraImageImportService(cameraStore);
        var bulkDataSync = new BulkDataSyncService(database, client, options);
        var syncViewModel = new SyncViewModel(
            database,
            bulkDataSync,
            new ArtCropDownloadService(database, client, options),
            coordinator);
        _ = syncViewModel.RefreshCountsAsync();

        var pythonRunner = new PythonProcessRunner(trainingPaths);
        var trainingHttpClient = new HttpClient();
        var trainingEnvironment = new TrainingEnvironmentService(
            trainingPaths,
            pythonRunner,
            trainingHttpClient);
        var exporter = new TrainingResultExporter(trainingPaths);
        var extractionWorkflow = new ExtractionProductionWorkflowService(
            trainingPaths, pythonRunner, exporter);
        var cornerSuggestions = new ExtractionCornerSuggestionService(
            trainingPaths, pythonRunner, extractionWorkflow, _applicationLog!);
        var runnerViewModel = new RunnerViewModel(
            database,
            trainingPaths,
            trainingEnvironment,
            pythonRunner,
            exporter,
            new IdentityProductionWorkflowService(trainingPaths, pythonRunner, exporter),
            coordinator,
            _applicationLog);

        var window = new MainWindow
        {
            DataContext = new ShellViewModel(
                syncViewModel,
                new AnnotatorViewModel(cameraStore, cameraImporter, coordinator, cornerSuggestions),
                new PhotoLibraryViewModel(cameraStore, coordinator),
                new ExtractionTrainingViewModel(
                    trainingPaths,
                    trainingEnvironment,
                    extractionWorkflow,
                    new ExtractionAssetDownloadService(database, trainingPaths, trainingHttpClient),
                    bulkDataSync,
                    coordinator,
                    _applicationLog),
                runnerViewModel),
        };
        MainWindow = window;
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        window.Closed += async (_, _) =>
        {
            await cornerSuggestions.DisposeAsync();
            _applicationLog.Information("lifecycle", "Main window closed.");
        };
        window.Show();
        _applicationLog.Information("startup", "Main window shown.");
    }

    private void RegisterApplicationLogging()
    {
        DispatcherUnhandledException += (_, args) =>
            _applicationLog?.Error("dispatcher", "Unhandled UI exception.", args.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            _applicationLog?.Error(
                "app-domain",
                $"Unhandled process exception. Terminating={args.IsTerminating}.",
                args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            _applicationLog?.Error("task-scheduler", "Unobserved task exception.", args.Exception);
            args.SetObserved();
        };
        Exit += (_, args) =>
            _applicationLog?.Information("lifecycle", $"Application exiting with code {args.ApplicationExitCode}.");
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
