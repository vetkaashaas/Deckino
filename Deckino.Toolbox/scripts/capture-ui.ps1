# Captures every Toolbox workspace at a set of window sizes, as a repeatable visual check of the UI.
# Output: bin\ui-screenshots\<width>x<height>\<Workspace>.png (bin is git-ignored; the Dataset Sync
# capture shows the bucket name and access key ID, so keep these images local).
#
# The script drives the real app through UI Automation. It starts the Debug build if the Toolbox is not
# already running and closes it again afterwards. Opening Model Training runs its automatic, read-only
# requirements check once.
[CmdletBinding()]
param(
    [string]$Configuration = "Debug",
    [string[]]$Sizes = @("900x640", "1280x800", "1600x940", "1920x1040"),
    [string]$OutDir
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $projectRoot "bin\ui-screenshots" }
$exe = Join-Path $projectRoot "bin\$Configuration\net10.0-windows10.0.19041.0\win-x64\Deckino.Toolbox.exe"
$workspaces = @("Scryfall Sync", "Dataset Sync", "Video Import", "Corner Annotator", "Photo Library", "Card Extraction", "Model Training")

Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ToolboxWindow {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    public struct RECT { public int L, T, R, B; }
}
'@
[ToolboxWindow]::SetProcessDPIAware() | Out-Null

$process = Get-Process Deckino.Toolbox -ErrorAction SilentlyContinue | Select-Object -First 1
$startedHere = -not $process
if ($startedHere) {
    if (-not (Test-Path -LiteralPath $exe)) { throw "Build the Toolbox first; $exe does not exist." }
    $process = Start-Process $exe -PassThru
    for ($i = 0; $i -lt 60 -and $process.MainWindowHandle -eq 0; $i++) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
    }
    Start-Sleep -Seconds 3
}
$process.Refresh()
$window = $process.MainWindowHandle
if ($window -eq 0) { throw "The Toolbox window did not appear." }
[ToolboxWindow]::ShowWindow($window, 9) | Out-Null
$scale = [ToolboxWindow]::GetDpiForWindow($window) / 96.0
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window)

function Select-Workspace([string]$name) {
    $byName = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name)
    foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $byName)) {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
            return
        }
    }
    throw "No sidebar entry named '$name' was found."
}

function Save-Window([string]$path) {
    $rect = New-Object ToolboxWindow+RECT
    [ToolboxWindow]::GetWindowRect($window, [ref]$rect) | Out-Null
    $bitmap = New-Object System.Drawing.Bitmap ($rect.R - $rect.L), ($rect.B - $rect.T)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    [ToolboxWindow]::PrintWindow($window, $hdc, 2) | Out-Null
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

foreach ($size in $Sizes) {
    $width, $height = $size.Split("x") | ForEach-Object { [int]$_ }
    $folder = Join-Path $OutDir $size
    New-Item -ItemType Directory -Force $folder | Out-Null
    [ToolboxWindow]::SetWindowPos($window, [IntPtr]::Zero, 20, 20, [int]($width * $scale), [int]($height * $scale), 0x0014) | Out-Null
    Start-Sleep -Milliseconds 500
    foreach ($workspace in $workspaces) {
        Select-Workspace $workspace
        Start-Sleep -Milliseconds 2000
        Save-Window (Join-Path $folder (($workspace -replace " ", "") + ".png"))
    }
    Write-Host "Captured $($workspaces.Count) workspaces at $size"
}

if ($startedHere) { $process.CloseMainWindow() | Out-Null }
Write-Host "Screenshots: $OutDir"
