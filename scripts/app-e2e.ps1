<#
.SYNOPSIS
  Run the mobile app's Maestro flows on an Android emulator against the local E2E API.

.DESCRIPTION
  The app's counterpart of `npm run e2e` in Deckino.Web (AppPlan.md, Definition of Done):

  1. Builds the E2E APK (build-android-release.ps1 -E2E) when asked, or when there is none yet.
  2. Starts the API on http://localhost:5890 with the E2E database and the Scryfall fixture, exactly as
     Deckino.Web/playwright.config.ts does, and forces a catalogue import so the fixture is current.
  3. Starts the emulator (-Avd) unless one is already running, and installs the newest E2E APK.
  4. Runs the flows in Deckino.App/.maestro: the shell, the update screen, the catalogue, accounts and settings
     (account.yaml registers a new account each run), and the style guide (with
     Home) at the emulator's size and again at a small phone's (wm size 720x1280, density 320).

  Reports (JUnit XML) land in Deckino.App/e2e-results/maestro, every milestone screenshot in its screenshots folder. Needs Maestro
  (~/.maestro/maestro/bin on PATH or there) and Java 17.

.PARAMETER Build
  Build a fresh E2E APK first. Needed after any app change.

.PARAMETER Avd
  The emulator to start when none is running. Default: deckino_e2e, a Pixel 9 Pro (API 36) kept for these tests
  with no screen lock (a lock leaves storage locked after a cold boot, and Maestro's driver cannot start).

.EXAMPLE
  .\scripts\app-e2e.ps1 -Build
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [string]$Avd = "deckino_e2e"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $repoRoot "Deckino.App"
$flows = Join-Path $appRoot ".maestro"
$results = Join-Path $appRoot "e2e-results\maestro"
$apiUrl = "http://localhost:5890"
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"
$emulator = Join-Path $sdk "emulator\emulator.exe"
$maestro = Get-Command maestro -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $maestro) { $maestro = Join-Path $HOME ".maestro\maestro\bin\maestro.bat" }
if (-not (Test-Path -LiteralPath $maestro)) { throw "Maestro not found. Install it: https://docs.maestro.dev/getting-started/installing-maestro" }

# Native tools write progress to stderr; only their exit code says whether they failed.
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $FilePath @Arguments } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "'$FilePath $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
}

function Get-NewestApk {
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "Output") -Filter "deckino-*-e2e-*.apk" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if ($Build -or -not (Get-NewestApk)) {
    & (Join-Path $PSScriptRoot "build-android-release.ps1") -E2E
}
$apk = Get-NewestApk

Write-Host "Starting the E2E API on $apiUrl..." -ForegroundColor Cyan
$apiEnvironment = @{
    ASPNETCORE_ENVIRONMENT = "Development"
    ASPNETCORE_URLS = $apiUrl
    App__BaseUrl = $apiUrl
    Mailgun__ApiKey = ""
    ConnectionStrings__Deckino = "Host=localhost;Port=55432;Database=deckino_e2e;Username=deckino;Password=deckino"
    Catalogue__BulkFile = Join-Path $repoRoot "Deckino.Web\e2e\fixtures\cards.jsonl.gz"
}
$saved = @{}
foreach ($name in $apiEnvironment.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name, $apiEnvironment[$name])
}
$apiLog = Join-Path $results "api.log"
New-Item -ItemType Directory -Force -Path $results | Out-Null
Get-ChildItem -LiteralPath $results | Remove-Item -Recurse -Force # one run's results only
try {
    $api = Start-Process dotnet -ArgumentList @("run", "--project", (Join-Path $repoRoot "Deckino.Api"), "--no-launch-profile") `
        -RedirectStandardOutput $apiLog -RedirectStandardError "$apiLog.err" -PassThru -WindowStyle Hidden
}
finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
}

try {
    $deadline = (Get-Date).AddMinutes(3)
    while ($true) {
        try { if ((Invoke-WebRequest "$apiUrl/api/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { break } } catch { }
        if ($api.HasExited) { throw "The API stopped while starting; see $apiLog." }
        if ((Get-Date) -gt $deadline) { throw "The API did not start within 3 minutes; see $apiLog." }
        Start-Sleep -Seconds 2
    }
    Invoke-WebRequest "$apiUrl/api/dev/catalogue/sync" -Method Post -UseBasicParsing -TimeoutSec 300 | Out-Null

    function Test-Emulator { [bool]((& $adb devices) -match "^emulator-\d+\s+device") }
    function Start-Emulator {
        Write-Host "Starting emulator $Avd..." -ForegroundColor Cyan
        # Hyper-V reserves the emulator's default ports (5554-5585; see `netsh int ipv4 show excludedportrange
        # protocol=tcp`), where it aborts with "too many emulator instances". 5680 is outside the reserved ranges.
        Start-Process $emulator -ArgumentList @("-avd", $Avd, "-port", "5680", "-memory", "4096", "-no-snapshot-save",
            "-no-boot-anim", "-no-audio") -WindowStyle Minimized | Out-Null
        $deadline = (Get-Date).AddMinutes(4)
        # Until the emulator registers, adb says so on stderr, which Windows PowerShell turns into an error.
        while ($(try { & $adb -e shell getprop sys.boot_completed 2>$null } catch { $null }) -ne "1") {
            if ((Get-Date) -gt $deadline) { throw "The emulator $Avd did not boot within 4 minutes." }
            Start-Sleep -Seconds 2
        }
    }
    if (-not (Test-Emulator)) { Start-Emulator }
    # -e and --device: a phone on USB must not get the x86_64 APK or the flows.
    $serial = (& $adb -e get-serialno).Trim()
    # The emulator keeps a screen size across restarts: a run that died at the small size would leave it there.
    & $adb -e shell wm size reset
    & $adb -e shell wm density reset
    Write-Host "Installing $($apk.Name)..." -ForegroundColor Cyan
    Invoke-Native $adb @("-e", "install", "-r", $apk.FullName)

    function Invoke-Flow([string]$Flow, [string[]]$Extra = @()) {
        $name = [IO.Path]::GetFileNameWithoutExtension($Flow) + ($Extra -join "" -replace "[^a-z]", "")
        $arguments = @("--device", $serial, "test", "--format", "junit", "--output", (Join-Path $results "$name.xml"),
            "--test-output-dir", (Join-Path $results "debug")) + $Extra + @((Join-Path $flows $Flow))
        Write-Host "Flow $Flow $Extra" -ForegroundColor Cyan
        Push-Location $results # a relative takeScreenshot path resolves against the working directory
        try {
            try { Invoke-Native $maestro $arguments }
            catch {
                # The emulator sometimes quits mid-run on this PC without a crash report (Deckino.App/AGENTS.md). Only
                # then: start it again (the app and any wm size stay) and give the flow one more go.
                if (Test-Emulator) { throw }
                Write-Warning "The emulator went away during $Flow; restarting it and running the flow again."
                Start-Emulator
                Invoke-Native $maestro $arguments
            }
        }
        finally { Pop-Location }
    }

    Invoke-Flow "shell.yaml"
    Invoke-Flow "update.yaml"
    Invoke-Flow "cards.yaml"
    Invoke-Flow "account.yaml"
    Invoke-Flow "styleguide.yaml" @("-e", "SIZE=large")
    Invoke-Native $adb @("-e", "shell", "wm", "size", "720x1280")
    Invoke-Native $adb @("-e", "shell", "wm", "density", "320")
    try { Invoke-Flow "styleguide.yaml" @("-e", "SIZE=small") }
    finally {
        & $adb -e shell wm size reset
        & $adb -e shell wm density reset
    }

    # Not automated: a scan. The camera needs a real card, and a photo shared from adb can't be read (Android copies a
    # share into the app's cache only for a granting sender, which the shell isn't). Scan-to-card is covered by
    # Playwright (catalogue.spec.ts, /api/cards/by-artwork) and by hand on a phone.

    Write-Host ""
    Write-Host "All flows passed. Screenshots and reports: $results" -ForegroundColor Green
}
finally {
    # Maestro keeps each flow's screenshots under debug\<time>\<flow name>\takeScreenshot; gather them in one place,
    # named by milestone, so two runs compare file by file. Also after a failure: the shots up to it.
    $screenshots = Join-Path $results "screenshots"
    New-Item -ItemType Directory -Force -Path $screenshots | Out-Null
    Get-ChildItem -LiteralPath $results -Recurse -Filter *.png |
        Where-Object { $_.Directory.Name -eq "takeScreenshot" } | Copy-Item -Destination $screenshots
    Stop-Process -Id $api.Id -ErrorAction SilentlyContinue
    # dotnet run starts the API as a child process; it is the one holding the port.
    Get-NetTCPConnection -LocalPort 5890 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue }
}
