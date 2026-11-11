<#
.SYNOPSIS
  Ensure the Expo app ships the card title reader (the OCR fallback for cards the artwork model is unsure of).

.DESCRIPTION
  The title reader counterpart of ensure-artwork-mobile.ps1:
  pinned text recognizer -> title reader export -> app verification -> Deckino.App assets.

  1. Runs export-title-reader into data/training/mobile/title/: it downloads the pinned
     PP-OCRv5 English recognizer once (checksum-checked, into data/training/ocr) and writes the model,
     its characters, the shared constants and a parity fixture.
  2. Runs Deckino.App/scripts/verify-title-reader.mjs: the app's TypeScript must cut, decode and match
     titles exactly as the Toolbox's title_ocr.py. Every run: a logic change leaves the manifest alone.
  3. If Deckino.App/assets/models/title already holds title-reader.onnx with the checksum and schema its
     title-manifest.json names, and the export wrote the same manifest, exits 0.
  4. Otherwise copies title-reader.onnx, characters.json and title-manifest.json into the App.

  Called by deckino-android-dev.ps1 and build-android-release.ps1. Safe to run twice.

.PARAMETER DataRoot
  Deckino data folder. Default: %LOCALAPPDATA%\Deckino\data (the Toolbox's).

.PARAMETER Force
  Re-run the export, verification and copy even when the App is current.

.PARAMETER WarnOnly
  On failure, print a warning and exit 0 so Metro still starts with the previous reader.

.PARAMETER PythonExe
  Python executable for the export. Default: the Toolbox venv python, then "python", then "py -3".
  Must have torch, numpy, pillow and onnxruntime (the training CLI imports torch).
#>
[CmdletBinding()]
param(
    [string]$DataRoot,
    [switch]$Force,
    [switch]$WarnOnly,
    [string]$PythonExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Must match TITLE_READER_SCHEMA_VERSION in Deckino.App/src/recognition/title/title-reader.ts.
$RequiredSchema = 1
$AppFiles = @("title-reader.onnx", "characters.json", "title-manifest.json")

function Get-RepoRoot {
    $dir = Get-Item -LiteralPath $PSScriptRoot
    while ($null -ne $dir) {
        if (Test-Path -LiteralPath (Join-Path $dir.FullName ".git")) { return $dir.FullName }
        $dir = $dir.Parent
    }
    throw "Could not find the Deckino repository root from $PSScriptRoot."
}

# True when $folder holds a complete reader at the required schema whose model matches its manifest's checksum.
function Test-Reader([string]$folder) {
    $manifestPath = Join-Path $folder "title-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $false }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ([int]$manifest.title_reader_schema_version -ne $RequiredSchema) { return $false }
        foreach ($name in $AppFiles) {
            if (-not (Test-Path -LiteralPath (Join-Path $folder $name))) { return $false }
        }
        $hash = (Get-FileHash -LiteralPath (Join-Path $folder "title-reader.onnx") -Algorithm SHA256).Hash.ToLowerInvariant()
        return $hash -eq [string]$manifest.model_sha256
    }
    catch {
        return $false
    }
}

function Resolve-PythonExe([string]$requested) {
    if (-not [string]::IsNullOrWhiteSpace($requested)) {
        return @{ Exe = $requested; PrefixArgs = @() }
    }
    $venvPython = Join-Path $env:LOCALAPPDATA "Deckino\training-runtime-v3\venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) { return @{ Exe = $venvPython; PrefixArgs = @() } }
    $python = Get-Command "python" -ErrorAction SilentlyContinue
    if ($null -ne $python) { return @{ Exe = "python"; PrefixArgs = @() } }
    $py = Get-Command "py" -ErrorAction SilentlyContinue
    if ($null -ne $py) { return @{ Exe = "py"; PrefixArgs = @("-3") } }
    throw "No Python found for export-title-reader. Install Python 3.12 with 'pip install torch numpy pillow onnxruntime', then re-run."
}

$repoRoot = Get-RepoRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $env:LOCALAPPDATA "Deckino\data"
}
$trainingRoot = Join-Path $DataRoot "training"
$source = Join-Path $trainingRoot "mobile\title"
$appRoot = Join-Path $repoRoot "Deckino.App"
$destination = Join-Path $appRoot "assets\models\title"

try {
    # The export is cheap once the model is downloaded, and it carries the constants and fixture the app is
    # checked against: always write it, so a change to title_ocr.py reaches the app.
    $python = Resolve-PythonExe $PythonExe
    $env:PYTHONPATH = Join-Path $repoRoot "Deckino.Tools\training\src"
    $env:PYTHONUTF8 = "1"
    $env:PYTHONUNBUFFERED = "1"
    $exportArgs = @() + $python.PrefixArgs + @(
        "-m", "deckino_training", "export-title-reader",
        "--training-root", $trainingRoot,
        "--output-dir", $source
    )
    # Quiet on success; the CLI reports a failure as an "error" event on stdout, so show the tail then.
    $exportOutput = & $python.Exe @exportArgs
    if ($LASTEXITCODE -ne 0) {
        throw "export-title-reader failed with exit code $LASTEXITCODE.`n$(($exportOutput | Select-Object -Last 5) -join "`n")"
    }
    if (-not (Test-Reader $source)) {
        throw "Export finished but $source is not a complete schema v$RequiredSchema title reader."
    }

    # Always: a change to title-core.ts or title_ocr.py's logic leaves the manifest as it was.
    Write-Host "Verifying the app's title reading code against the Toolbox's fixture..."
    & node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON (Join-Path $appRoot "scripts\verify-title-reader.mjs") $source
    if ($LASTEXITCODE -ne 0) {
        throw "verify-title-reader.mjs failed: the app's title_ocr mirror (src/recognition/title/title-core.ts) differs from the Toolbox."
    }

    $sameManifest = (Test-Path -LiteralPath (Join-Path $destination "title-manifest.json")) -and
        ((Get-Content -LiteralPath (Join-Path $source "title-manifest.json") -Raw) -eq
         (Get-Content -LiteralPath (Join-Path $destination "title-manifest.json") -Raw))
    if (-not $Force -and $sameManifest -and (Test-Reader $destination)) {
        Write-Host "Title reader up to date in Expo app."
        exit 0
    }

    Write-Host "Copying the title reader into Deckino.App..."
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    foreach ($name in $AppFiles) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Force
    }
    if (-not (Test-Reader $destination)) {
        throw "Copy finished but the App's title reader is incomplete."
    }
    $bytes = (Get-Item -LiteralPath (Join-Path $destination "title-reader.onnx")).Length
    Write-Host ("Title reader ready in Expo app (title-reader.onnx {0:N1} MB). Restart Metro to serve it." -f ($bytes / 1MB))
    exit 0
}
catch {
    if ($WarnOnly) {
        Write-Warning ("ensure-title-reader: continuing with the previous title reader. " + $_.Exception.Message)
        exit 0
    }
    throw
}
