<#
.SYNOPSIS
  Put a standalone build of Deckino on the attached phone - no Metro needed.

.DESCRIPTION
  deckino-android-dev.ps1 runs the dev client, which only works while Metro is
  running on this PC. This script installs a release build instead: JS bundle and
  models are inside the APK, so the app works anywhere, cable or not.

  It is a thin wrapper around build-android-release.ps1 -Install, which builds the
  APK, copies it to scripts\Output and installs it as "Deckino Preview"
  (com.deckino.app.preview). The dev client (Deckino) stays installed next to it.

  With -SkipBuild it reinstalls the newest APK already in scripts\Output instead
  of building again.

.PARAMETER Serial
  adb serial of the phone. Default: the same phone deckino-android-dev.ps1 uses.

.PARAMETER SkipBuild
  Do not build; install the newest deckino-*-release-*.apk from scripts\Output.

.PARAMETER Clean
  Regenerate Deckino.App/android from scratch first (after app.json, plugin or
  native dependency changes). Ignored with -SkipBuild.

.PARAMETER SkipModelCheck
  Build with whatever models the app currently has. Ignored with -SkipBuild.

.EXAMPLE
  .\scripts\deckino-android-deploy.ps1

.EXAMPLE
  .\scripts\deckino-android-deploy.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [string]$Serial = "RZCY326LL3P",
    [switch]$SkipBuild,
    [switch]$Clean,
    [switch]$SkipModelCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Package = "com.deckino.app.preview"
$Activity = "com.deckino.app.MainActivity"

if (-not $SkipBuild) {
    $buildArgs = @{ Install = $true; Serial = $Serial }
    if ($Clean) { $buildArgs.Clean = $true }
    if ($SkipModelCheck) { $buildArgs.SkipModelCheck = $true }
    & (Join-Path $PSScriptRoot "build-android-release.ps1") @buildArgs
    return
}

$sdk = $env:ANDROID_HOME
if ([string]::IsNullOrWhiteSpace($sdk)) { $sdk = $env:ANDROID_SDK_ROOT }
if ([string]::IsNullOrWhiteSpace($sdk)) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"
if (-not (Test-Path -LiteralPath $adb)) {
    throw "adb not found at $adb"
}

& $adb start-server | Out-Null
$state = ((& $adb -s $Serial get-state 2>&1) | Out-String).Trim()
if ($state -ne "device") {
    & $adb devices -l
    throw "Phone $Serial is not ready (adb state: '$state'). Plug it in and allow USB debugging."
}

$apk = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "Output") -Filter "deckino-*-release-*.apk" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $apk) {
    throw "No release APK in scripts\Output. Run without -SkipBuild first."
}

Write-Host "Installing $($apk.Name) ($($apk.LastWriteTime)) on $Serial..." -ForegroundColor Cyan
& $adb -s $Serial install -r $apk.FullName
if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE." }
& $adb -s $Serial shell am start -n "$Package/$Activity"
if ($LASTEXITCODE -ne 0) { throw "Starting $Package failed with exit code $LASTEXITCODE." }
Write-Host "Started 'Deckino Preview'. The dev client (Deckino) is still installed alongside it." -ForegroundColor Green
