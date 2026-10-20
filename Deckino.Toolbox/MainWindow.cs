using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Deckino.Toolbox.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Deckino.Toolbox;

/// <summary>The window: WebView2 filling a dark form, showing the React UI the local server sends.</summary>
public sealed class MainWindow : Form
{
    private static readonly Color Background = Color.FromArgb(0x0B, 0x06, 0x10);
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Background };
    private readonly Uri _start;
    private readonly int _serverPort;
    private readonly string _token;
    private readonly bool _developer;
    private readonly ApplicationLogService _log;

    /// <summary>Paths of photos or folders dropped onto the Photo Library.</summary>
    public event Action<IReadOnlyList<string>>? FilesDropped;

    /// <param name="start">The page: this process's server, or in dev the Vite server in front of it.</param>
    /// <param name="serverPort">This process's server, which the token cookie is for.</param>
    public MainWindow(Uri start, int serverPort, string token, bool developer, ApplicationLogService log)
    {
        _start = start;
        _serverPort = serverPort;
        _token = token;
        _developer = developer;
        _log = log;
        Text = "Deckino Toolbox";
        BackColor = Background;
        using (var icon = typeof(MainWindow).Assembly.GetManifestResourceStream("deckino.ico"))
            if (icon is not null) Icon = new Icon(icon);
        // The old window's 1600 × 940, in display-scaled units like it was: pixels here, so times the display scaling.
        // Opens centred on the screen it starts on, shrunk to fit when that is larger than the screen.
        var scale = DeviceDpi / 96.0;
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        MinimumSize = new Size((int)(900 * scale), (int)(640 * scale));
        Size = new Size(Math.Min((int)(1600 * scale), area.Width), Math.Min((int)(940 * scale), area.Height));
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_web);
        Load += async (_, _) =>
        {
            try
            {
                await ShowPageAsync();
            }
            catch (Exception error)
            {
                Fail("The Toolbox window could not start WebView2", error);
            }
        };
    }

    // Without WebView2 the page, and every message it would show, is gone: say so natively and close.
    private void Fail(string problem, Exception? error)
    {
        _log.Error("window", $"{problem}.", error);
        MessageBox.Show(this, $"{problem}{(error is null ? "" : $": {error.Message}")}\n\nRestart the Toolbox. If this keeps "
            + "happening, reinstall it, which also installs the Microsoft Edge WebView2 Runtime.",
            "Deckino Toolbox", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Dark title bar to match the page.
        var dark = 1;
        _ = DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
    }

    private static readonly HashSet<string> EditingMenuItems =
        ["undo", "redo", "cut", "copy", "paste", "pasteAsPlainText", "pasteAndMatchStyle", "selectAll"];

    private async Task ShowPageAsync()
    {
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Deckino", "WebView2");
        var environment = await CoreWebView2Environment.CreateAsync(null, userData);
        await _web.EnsureCoreWebView2Async(environment);
        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = _developer;
        // Text keeps its editing menu (Cut, Copy, Paste); the browser's own items (Back, Reload, Save as) are a
        // developer's only.
        if (!_developer)
            core.ContextMenuRequested += (_, args) =>
            {
                var items = args.MenuItems;
                for (var index = items.Count - 1; index >= 0; index--)
                    if (!EditingMenuItems.Contains(items[index].Name)) items.RemoveAt(index);
                args.Handled = items.Count == 0;
            };
        core.Settings.AreBrowserAcceleratorKeysEnabled = _developer;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        // Cookies ignore ports and every Toolbox shares this profile, so each server's cookie has its own name.
        foreach (var host in new[] { "localhost", "127.0.0.1" })
        {
            var cookie = core.CookieManager.CreateCookie(Bridge.BridgeEndpoints.TokenCookie(_serverPort), _token, host, "/");
            cookie.IsHttpOnly = true;
            cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            core.CookieManager.AddOrUpdateCookie(cookie);
        }
        // Dropped files reach the page without their paths; the page hands them back here, where WebView2 has them.
        // Virtual items (a phone browsed over MTP, zip contents) have no file system path and are left out.
        core.WebMessageReceived += (_, args) =>
        {
            if (args.TryGetWebMessageAsString() != "import-photos" || args.AdditionalObjects is not { } objects) return;
            var paths = objects.OfType<CoreWebView2File>().Select(file => file.Path).Where(path => !string.IsNullOrEmpty(path)).ToArray();
            if (paths.Length > 0) FilesDropped?.Invoke(paths);
        };
        core.ProcessFailed += (_, args) =>
        {
            if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                Fail("The Toolbox window's browser stopped", null);
            else if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
            {
                _log.Error("window", $"The page's process ended ({args.Reason}, exit code {args.ExitCode}); reloading it.");
                core.Reload();
            }
        };
        // Links open in the default browser, never in a second window.
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
        };
        _web.Source = _start;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
