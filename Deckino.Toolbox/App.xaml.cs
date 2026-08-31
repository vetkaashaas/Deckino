using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox;

public partial class App : Application
{
    private readonly IServiceProvider _services;
    private readonly ICameraDatasetSyncService _cameraSync;
    private readonly ExtractionCornerSuggestionService _cornerSuggestions;
    private readonly IDesktopService _desktop;
    private readonly ApplicationLogService _applicationLog;
    private readonly HeadlessCommandRunner _headless;
    private bool _approvedClose;

    public App(
        IServiceProvider services,
        ICameraDatasetSyncService cameraSync,
        ExtractionCornerSuggestionService cornerSuggestions,
        IDesktopService desktop,
        ApplicationLogService applicationLog,
        HeadlessCommandRunner headless)
    {
        InitializeComponent();
        _services = services;
        _cameraSync = cameraSync;
        _cornerSuggestions = cornerSuggestions;
        _desktop = desktop;
        _applicationLog = applicationLog;
        _headless = headless;
        RegisterApplicationLogging();
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        var arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
        var headless = arguments.Any(value => value.Equals("--sync", StringComparison.OrdinalIgnoreCase)
            || value.Equals("--sync-art", StringComparison.OrdinalIgnoreCase));
        // Resolve the visual tree only after InitializeComponent has loaded the
        // application resource dictionaries. Resolving AppShell in this class's
        // constructor causes its StaticResource lookups to run too early.
        var rootPage = headless
            ? new ContentPage()
            : _services.GetRequiredService<AppShell>();
        var window = new Window(rootPage)
        {
            Title = "Deckino Toolbox",
            Width = 1600,
            Height = 940,
            MinimumWidth = 900,
            MinimumHeight = 640,
        };
        window.Created += async (_, _) =>
        {
            ConfigureNativeWindow(window);
            if (!headless) return;
            HideNativeWindow(window);
            var exitCode = await _headless.RunAsync(arguments);
            Environment.ExitCode = exitCode;
            Current?.Quit();
        };
        window.Destroying += async (_, _) =>
        {
            await _cornerSuggestions.DisposeAsync();
            await _cameraSync.DisposeAsync();
            _applicationLog.Information("lifecycle", "Deckino Toolbox window closed.");
        };
        _applicationLog.Information("startup", $"Deckino Toolbox starting. PID={Environment.ProcessId}; base={AppContext.BaseDirectory}");
        return window;
    }

    private void ConfigureNativeWindow(Window window)
    {
        if (window.Handler?.PlatformView is not Microsoft.UI.Xaml.Window nativeWindow) return;
        nativeWindow.AppWindow.Closing += async (_, args) =>
        {
            if (_approvedClose) return;
            var snapshot = _cameraSync.GetSnapshot();
            if (!snapshot.IsConfigured || snapshot.SafeToSwitch) return;
            args.Cancel = true;
            var title = snapshot.IsRunning
                ? "Dataset sync is still running"
                : "Dataset uploads are not finished";
            var message = snapshot.IsRunning
                ? "Deckino is currently reading or comparing the dataset. Closing now cancels this sync pass. "
                  + "Local files are preserved, and synchronization can be run again next launch. Close anyway?"
                : $"Deckino still has {snapshot.PendingUploads:N0} pending, {snapshot.FailedOperations:N0} failed, "
                  + $"and {snapshot.ConflictCount:N0} conflicting dataset operations.\n\n"
                  + "The queue will resume next launch, but this computer is not safe to switch from. Close anyway?";
            var close = await _desktop.ConfirmAsync(
                title,
                message,
                "Close anyway");
            if (!close) return;
            _approvedClose = true;
            nativeWindow.Close();
        };
    }

    private static void HideNativeWindow(Window window)
    {
        if (window.Handler?.PlatformView is Microsoft.UI.Xaml.Window nativeWindow)
            nativeWindow.AppWindow.Hide();
    }

    private void RegisterApplicationLogging()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            _applicationLog.Error("app-domain", $"Unhandled process exception. Terminating={args.IsTerminating}.", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            _applicationLog.Error("task-scheduler", "Unobserved task exception.", args.Exception);
            args.SetObserved();
        };
    }
}
