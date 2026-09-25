<#
.SYNOPSIS
  Build an installable release APK of Deckino to measure real release-build speed.

.DESCRIPTION
  A development build (dev client + Metro) runs JavaScript unoptimized and with
  debug overhead, so its HUD timings are pessimistic. This builds the same app as
  a release APK: Hermes bytecode, no dev tools, the JS bundle and models inside
  the APK - no Metro needed on the phone.

  1. Makes sure the Expo app carries the latest imported extraction and artwork
     models (ensure-extraction-mobile.ps1, ensure-artwork-mobile.ps1).
  2. Generates Deckino.App/android with expo prebuild if it does not exist
     (or with -Clean, from scratch).
  3. Makes the release build installable next to the dev client: application id
     com.deckino.app.preview and the name "Deckino Preview". The dev client
     (com.deckino.app) stays on the phone untouched. Both edits only touch the
     generated android folder and are re-applied on every run.
  4. Runs gradle assembleRelease for the phone's ABI only (arm64-v8a by default).
  5. Copies the APK to scripts\Output and, with -Install, installs and starts it.

  Signed with the Expo template's debug keystore: fine for sideloading onto your
  own phone, not for the Play Store (there is no upload key yet).

.PARAMETER Install
  adb-install the APK on the phone and start it.

.PARAMETER Serial
  adb serial of the phone. Default: the same phone start-deckino-android.ps1 uses.

.PARAMETER Architectures
  ABIs to compile native code for. Default arm64-v8a (every recent phone); more
  ABIs make the build much slower.

.PARAMETER Clean
  Regenerate Deckino.App/android from scratch (expo prebuild --clean) first. Use
  after changing app.json, plugins or native dependencies.

.PARAMETER SkipModelCheck
  Build with whatever models the app currently has.

.PARAMETER OutputDirectory
  Where the APK is copied. Default: scripts\Output.

.EXAMPLE
  .\scripts\build-android-release.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [string]$Serial = "RZCY326LL3P",
    [string[]]$Architectures = @("arm64-v8a"),
    [switch]$Clean,
    [switch]$SkipModelCheck,
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ApplicationIdSuffix = ".preview"
$PreviewAppName = "Deckino Preview"
$BasePackage = "com.deckino.app"
$PatchMarker = "// deckino: release preview id (scripts/build-android-release.ps1)"

if ($env:OS -ne "Windows_NT") {
    throw "This build script currently supports Windows only."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $repoRoot "Deckino.App"
$androidRoot = Join-Path $appRoot "android"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot "Output"
}

function Resolve-RequiredCommand([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "Required command '$Name' was not found on PATH."
    }
    return $command.Source
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
    # Gradle and npx write warnings to stderr; when output is redirected, Windows
    # PowerShell turns those into terminating errors under "Stop". Judge by exit code.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $FilePath @Arguments
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($LASTEXITCODE -ne 0) {
        throw "'$FilePath $($Arguments -join ' ')' failed with exit code $LASTEXITCODE."
    }
}

function Resolve-Adb {
    $sdk = $env:ANDROID_HOME
    if ([string]::IsNullOrWhiteSpace($sdk)) { $sdk = $env:ANDROID_SDK_ROOT }
    if ([string]::IsNullOrWhiteSpace($sdk)) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
    $adb = Join-Path $sdk "platform-tools\adb.exe"
    if (-not (Test-Path -LiteralPath $adb)) {
        throw "adb not found at $adb"
    }
    return $adb
}

function Write-Utf8([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# Give the release build type its own application id, once.
function Set-PreviewApplicationId([string]$BuildGradlePath) {
    $gradle = Get-Content -LiteralPath $BuildGradlePath -Raw
    if ($gradle.Contains($PatchMarker)) {
        return
    }
    $pattern = [regex]::new('(?ms)(    buildTypes \{.*?\r?\n        release \{\r?\n)')
    $found = $pattern.Matches($gradle)
    if ($found.Count -ne 1) {
        throw "Expected one release build type in $BuildGradlePath, found $($found.Count). Re-run with -Clean."
    }
    $match = $found[0]
    $insert = "            $PatchMarker`n            applicationIdSuffix '$ApplicationIdSuffix'`n"
    Write-Utf8 $BuildGradlePath $gradle.Insert($match.Index + $match.Length, $insert)
}

# A release-only resource overrides the app name without touching the dev client's.
function Set-PreviewAppName([string]$AndroidRoot) {
    $valuesRoot = Join-Path $AndroidRoot "app\src\release\res\values"
    New-Item -ItemType Directory -Force -Path $valuesRoot | Out-Null
    $escaped = [System.Security.SecurityElement]::Escape($PreviewAppName)
    Write-Utf8 (Join-Path $valuesRoot "strings.xml") @"
<resources>
  <!-- Written by scripts/build-android-release.ps1 so the release preview is told apart from the dev client. -->
  <string name="app_name">$escaped</string>
</resources>
"@
}

$npx = Resolve-RequiredCommand "npx.cmd"
if ($Install) {
    $adb = Resolve-Adb
    & $adb start-server | Out-Null
    $state = ((& $adb -s $Serial get-state 2>&1) | Out-String).Trim()
    if ($state -ne "device") {
        & $adb devices -l
        throw "Phone $Serial is not ready (adb state: '$state'). Plug it in and allow USB debugging, or build without -Install."
    }
}

if (-not $SkipModelCheck) {
    Write-Host "Checking the app's models..." -ForegroundColor Cyan
    foreach ($script in @("ensure-extraction-mobile.ps1", "ensure-artwork-mobile.ps1")) {
        & (Join-Path $PSScriptRoot $script)
        if ($LASTEXITCODE -ne 0) {
            throw "$script failed with exit code $LASTEXITCODE. Re-run with -SkipModelCheck to build with the current models."
        }
    }
}

$previousNodeEnv = $env:NODE_ENV
Push-Location $appRoot
try {
    $env:NODE_ENV = "production"
    if ($Clean -or -not (Test-Path -LiteralPath (Join-Path $androidRoot "gradlew.bat"))) {
        Write-Host "Generating the Android project (expo prebuild)..." -ForegroundColor Cyan
        $prebuildArgs = @("expo", "prebuild", "--platform", "android", "--no-install")
        if ($Clean) { $prebuildArgs += "--clean" }
        Invoke-Checked $npx $prebuildArgs
    }

    Write-Host "Marking the release build as '$PreviewAppName' ($BasePackage$ApplicationIdSuffix)..." -ForegroundColor Cyan
    Set-PreviewApplicationId (Join-Path $androidRoot "app\build.gradle")
    Set-PreviewAppName $androidRoot

    $abiList = $Architectures -join ","
    Write-Host "Building the release APK for $abiList (first build compiles all native code and takes a while)..." -ForegroundColor Cyan
    Push-Location $androidRoot
    try {
        Invoke-Checked (Join-Path $androidRoot "gradlew.bat") @(
            "app:assembleRelease", "-PreactNativeArchitectures=$abiList"
        )
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
    $env:NODE_ENV = $previousNodeEnv
}

$apk = Join-Path $androidRoot "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path -LiteralPath $apk)) {
    throw "Gradle finished without producing $apk."
}
$version = (Get-Content -LiteralPath (Join-Path $appRoot "app.json") -Raw | ConvertFrom-Json).expo.version
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$artifact = Join-Path $resolvedOutput ("deckino-{0}-release-{1}.apk" -f $version, (Get-Date -Format "yyyyMMdd-HHmmss"))
Copy-Item -LiteralPath $apk -Destination $artifact
$megabytes = (Get-Item -LiteralPath $artifact).Length / 1MB
Write-Host ""
Write-Host ("Release APK: $artifact ({0:N1} MB)" -f $megabytes) -ForegroundColor Green

if ($Install) {
    $package = "$BasePackage$ApplicationIdSuffix"
    Write-Host "Installing $package on $Serial..." -ForegroundColor Cyan
    Invoke-Checked $adb @("-s", $Serial, "install", "-r", $artifact)
    Invoke-Checked $adb @("-s", $Serial, "shell", "am", "start", "-n", "$package/$BasePackage.MainActivity")
    Write-Host "Started '$PreviewAppName'. The dev client (Deckino) is still installed alongside it." -ForegroundColor Green
}
else {
    Write-Host "Install it with: .\scripts\build-android-release.ps1 -Install, or adb install -r `"$artifact`""
}
