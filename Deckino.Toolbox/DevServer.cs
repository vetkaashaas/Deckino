using System.ComponentModel;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Reflection;

namespace Deckino.Toolbox;

/// <summary>
/// F5 (Development): the window shows the UI's Vite dev server, with hot reload, and Vite passes /api on to this
/// process's server (vite.config.ts). Vite runs without a console window and is tied to this process, so it also
/// stops when Visual Studio ends the debug session.
/// </summary>
internal static class DevServer
{
    public const int Port = 5875;
    public static readonly Uri Url = new($"http://localhost:{Port}");

    /// <param name="api">This process's server, which Vite passes /api on to.</param>
    public static void Start(Uri api)
    {
        if (IsListening()) return; // started by hand (npm run dev)
        // Where the UI's source was at build time (Debug builds only, see the csproj).
        var uiRoot = typeof(DevServer).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key == "ToolboxUi")?.Value
            ?? throw new InvalidOperationException("Only a Debug build knows where the UI's source is.");
        var vite = Path.Combine(uiRoot, "node_modules", "vite", "bin", "vite.js");
        if (!File.Exists(vite))
            throw new InvalidOperationException($"Vite is missing: run npm install in {uiRoot}.");

        var start = new ProcessStartInfo("node", [vite])
        {
            WorkingDirectory = uiRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.Environment["DECKINO_TOOLBOX_API"] = api.GetLeftPart(UriPartial.Authority);
        var process = Process.Start(start)!;
        KillWithThisProcess(process);
        // Vite's own messages (and compile errors) go to Visual Studio's Output window.
        process.OutputDataReceived += (_, line) => { if (line.Data is not null) Debug.WriteLine($"vite: {line.Data}"); };
        process.ErrorDataReceived += (_, line) => { if (line.Data is not null) Debug.WriteLine($"vite: {line.Data}"); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        var deadline = DateTime.UtcNow.AddMinutes(1);
        while (!IsListening())
        {
            if (process.HasExited)
                throw new InvalidOperationException($"The Vite dev server stopped with exit code {process.ExitCode}; see the Output window.");
            if (DateTime.UtcNow > deadline) throw new TimeoutException("The Vite dev server did not start within a minute.");
            Thread.Sleep(100);
        }
    }

    private static bool IsListening() =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(endpoint => endpoint.Port == Port);

    // A job that ends its processes when its last handle closes, which Windows does when this process ends, however
    // it ends. The handle is never closed before that.
    private static void KillWithThisProcess(Process process)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimitInformation { Basic = new BasicLimitInformation { LimitFlags = KillOnJobClose } };
        if (job == IntPtr.Zero
            || !SetInformationJobObject(job, ExtendedLimitInformationClass, ref limits, Marshal.SizeOf<ExtendedLimitInformation>())
            || !AssignProcessToJobObject(job, process.Handle))
            throw new Win32Exception();
    }

    private const uint KillOnJobClose = 0x2000;
    private const int ExtendedLimitInformationClass = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation Basic;
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimitInformation information, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
