using System.Security.Cryptography;
using System.Windows.Forms;
using Deckino.Toolbox.Bridge;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.ViewModels;
using Velopack;

namespace Deckino.Toolbox;

public static class Program
{
    private static readonly string[] HeadlessFlags =
        ["--sync", "--sync-images", "--import-extraction", "--import-artwork", "--pack-artwork", "--pack-extraction-handoff"];

    /// <summary>
    /// Velopack first (it may install an update and exit), then either a headless command, or the local server plus
    /// the window. <c>--serve</c> runs the server without a window, for Playwright; <c>--urls</c> picks its address.
    /// </summary>
    [STAThread]
    public static int Main(string[] args)
    {
        VelopackApp.Build().Run();
        if (args.Any(argument => HeadlessFlags.Contains(argument, StringComparer.OrdinalIgnoreCase)))
            return RunHeadless(args);

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        var uiContext = new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(uiContext);

        var serveOnly = args.Contains("--serve", StringComparer.OrdinalIgnoreCase);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            // Configuration would read "--serve --urls x" as serve=--urls.
            Args = args.Where(argument => !argument.Equals("--serve", StringComparison.OrdinalIgnoreCase)).ToArray(),
            ContentRootPath = AppContext.BaseDirectory,
            // Only a Debug build is ever a developer's (F5): an installed Toolbox ignores a machine-wide
            // DOTNET_ENVIRONMENT=Development.
            EnvironmentName = IsDebugBuild ? null : Environments.Production,
        });
        var developer = builder.Environment.IsDevelopment();
        // Only --urls (Playwright) picks the address, never a machine-wide ASPNETCORE_URLS. Dev: a fixed port, so a Vite
        // started by hand (npm run dev) finds it. Otherwise any free loopback port, picked by Kestrel as it binds.
        if (!args.Any(argument => argument.StartsWith("--urls", StringComparison.OrdinalIgnoreCase)))
            builder.WebHost.UseUrls(developer ? "http://localhost:5885" : "http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        if (developer) builder.Logging.AddDebug();
        ToolboxServices.Add(builder.Services, uiContext);

        var app = builder.Build();
        var services = app.Services;
        var log = services.GetRequiredService<ApplicationLogService>();
        // A fixed token is for the E2E run (a Debug build) only: never an installed Toolbox's.
        var token = IsDebugBuild && Environment.GetEnvironmentVariable("DECKINO_TOOLBOX_TOKEN") is { Length: > 0 } fixedToken
            ? fixedToken
            : Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        app.UseBridgeErrors(log);
        app.UseBridgeSecurity(token);
        app.MapBridge();
        app.UseDefaultFiles();
        app.UseStaticFiles();
        app.MapFallback("/api/{**path}", () => Results.NotFound()); // a mistyped call is a 404, not the page
        app.MapFallbackToFile("index.html");

        LogCrashes(log, services.GetRequiredService<AppEvents>());
        log.Information("startup", $"Deckino Toolbox starting. PID={Environment.ProcessId}; base={AppContext.BaseDirectory}");
        // The view models are created here, on the UI thread they run on.
        var shell = services.GetRequiredService<ShellViewModel>();
        Task.Run(() => app.StartAsync()).GetAwaiter().GetResult();

        if (serveOnly)
        {
            Application.Run();
        }
        else
        {
            var server = new Uri(app.Urls.First());
            if (developer) DevServer.Start(server);
            using var window = new MainWindow(developer ? DevServer.Url : server, server.Port, token, developer, log);
            services.GetRequiredService<DesktopService>().Window = window;
            window.FilesDropped += paths => _ = services.GetRequiredService<PhotoLibraryViewModel>().ImportDroppedAsync(paths);
            GuardClose(window, services);
            window.Shown += (_, _) => _ = shell.StartBackgroundWorkAsync();
            // The services stop while the message loop still runs: the work they wait for resumes on this thread.
            window.FormClosed += async (_, _) =>
            {
                // A window closed before the loop runs (its page failed to load): ExitThread has to come from inside it.
                await Task.Yield();
                try
                {
                    await StopServicesAsync(services).WaitAsync(TimeSpan.FromSeconds(15));
                }
                catch (Exception error)
                {
                    log.Error("lifecycle", "Stopping the Toolbox's services failed.", error);
                }
                Application.ExitThread();
            };
            window.Show();
            Application.Run();
        }

        // Requests still waiting for the UI thread never finish now that its message loop has ended.
        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
            Task.Run(() => app.StopAsync(timeout.Token)).GetAwaiter().GetResult();
        log.Information("lifecycle", "Deckino Toolbox window closed.");
        return 0;
    }

    private static async Task StopServicesAsync(IServiceProvider services)
    {
        await services.GetRequiredService<ExtractionCornerSuggestionService>().DisposeAsync();
        await services.GetRequiredService<CardIdentitySuggestionService>().DisposeAsync();
        await services.GetRequiredService<ICameraDatasetSyncService>().DisposeAsync();
    }

#if DEBUG
    internal const bool IsDebugBuild = true;
#else
    internal const bool IsDebugBuild = false;
#endif

    private static int RunHeadless(string[] args)
    {
        var services = new ServiceCollection();
        ToolboxServices.Add(services, new SynchronizationContext());
        using var provider = services.BuildServiceProvider();
        return provider.GetRequiredService<HeadlessCommandRunner>().RunAsync(args).GetAwaiter().GetResult();
    }

    // Closing while dataset uploads wait (or a sync runs) asks first: this PC is not safe to switch from yet. A native
    // box, not the page's dialog, so it still shows when the page itself has failed.
    private static void GuardClose(MainWindow window, IServiceProvider services)
    {
        var sync = services.GetRequiredService<ICameraDatasetSyncService>();
        window.FormClosing += (_, args) =>
        {
            if (args.CloseReason == CloseReason.WindowsShutDown) return;
            var snapshot = sync.GetSnapshot();
            if (!snapshot.IsConfigured || snapshot.SafeToSwitch) return;
            var title = snapshot.IsRunning ? "Dataset sync is still running" : "Dataset uploads are not finished";
            var message = snapshot.IsRunning
                ? "Deckino is currently reading or comparing the dataset. Closing now cancels this sync pass. "
                  + "Local files are preserved, and synchronization can be run again next launch. Close anyway?"
                : $"Deckino still has {snapshot.PendingUploads:N0} pending, {snapshot.FailedOperations:N0} failed, "
                  + $"and {snapshot.ConflictCount:N0} conflicting dataset operations.\n\n"
                  + "The queue will resume next launch, but this computer is not safe to switch from. Close anyway?";
            args.Cancel = MessageBox.Show(window, message, title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2) != DialogResult.Yes;
        };
    }

    private static void LogCrashes(ApplicationLogService log, AppEvents events)
    {
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            log.Error("app-domain", $"Unhandled process exception. Terminating={args.IsTerminating}.", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            log.Error("task-scheduler", "Unobserved task exception.", args.Exception);
            args.SetObserved();
        };
        // An exception on the UI thread (an async void handler, a posted callback) is logged and shown, not fatal.
        Application.ThreadException += (_, args) =>
        {
            log.Error("ui-thread", "Unhandled UI thread exception.", args.Exception);
            events.Show($"Something went wrong: {args.Exception.Message}", "error");
        };
    }
}
