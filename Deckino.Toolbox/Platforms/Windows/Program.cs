using Velopack;

namespace Deckino.Toolbox.WinUI;

// Replaces the XAML-generated Main (DISABLE_XAML_GENERATED_MAIN in the project): Velopack must run first, before any
// window, to handle its install, update and uninstall hooks (ToolboxUpdateService).
public static class Program
{
    [STAThread]
    private static void Main()
    {
        VelopackApp.Build().Run();
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Microsoft.UI.Xaml.Application.Start(p =>
        {
            var context = new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
    }
}
