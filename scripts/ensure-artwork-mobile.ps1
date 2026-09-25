<#
.SYNOPSIS
  Ensure the Expo app ships the latest imported artwork recognizer.

.DESCRIPTION
  The artwork counterpart of ensure-extraction-mobile.ps1:
  imported artwork artifact -> mobile export -> app verification -> Deckino.App assets.

  1. Resolves the wanted version from -ModelVersion, else
     data/training/current-artwork.json (written by the Toolbox import), else the
     newest data/training/artifacts/* folder with embedding.pt and index/index.f32.
  2. If Deckino.App/assets/models/artwork/mobile-manifest.json already reports
     that version at the schema the app expects, exits 0 without doing anything.
  3. Otherwise runs export-artwork-mobile on CPU into
     data/training/mobile/artwork/<version>/ (skipped with -SkipExport), unless
     that export is already current.
  4. Runs Deckino.App/scripts/verify-artwork-model.mjs: the app's TypeScript crop
     and decision must reproduce the export's fixture. Writes app-verification.json
     into the export folder.
  5. Copies recognizer.onnx, app-labels.json and mobile-manifest.json into the App.

  Called automatically by start-deckino-android.ps1. Safe to run twice.

.PARAMETER ModelVersion
  Artwork artifact / export folder name. Default: current-artwork.json pointer.

.PARAMETER DataRoot
  Deckino data folder. Default: <repo>\data.

.PARAMETER SkipExport
  Do not run export-artwork-mobile; only verify and copy the existing export.

.PARAMETER Force
  Re-run the export, verification and copy even when the App is current.

.PARAMETER WarnOnly
  On failure, print a warning and exit 0 so Metro still starts with the
  previous model.

.PARAMETER PythonExe
  Python executable for the export. Default: "python", then "py -3", then the
  Toolbox venv python. Must have torch, onnx and onnxruntime.
#>
[CmdletBinding()]
param(
    [string]$ModelVersion,
    [string]$DataRoot,
    [switch]$SkipExport,
    [switch]$Force,
    [switch]$WarnOnly,
    [string]$PythonExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Must match ARTWORK_MOBILE_SCHEMA_VERSION in Deckino.App/src/recognition/artwork/artwork-recognizer.ts.
$RequiredSchema = 2
$AppFiles = @("recognizer.onnx", "app-labels.json", "mobile-manifest.json")

function Get-RepoRoot {
    $dir = Get-Item -LiteralPath $PSScriptRoot
    while ($null -ne $dir) {
        if (Test-Path -LiteralPath (Join-Path $dir.FullName ".git")) { return $dir.FullName }
        $dir = $dir.Parent
    }
    throw "Could not find the Deckino repository root from $PSScriptRoot."
}

function Get-WantedVersion([string]$artifactsRoot, [string]$pointerPath, [string]$requested) {
    if (-not [string]::IsNullOrWhiteSpace($requested)) { return $requested }
    if (Test-Path -LiteralPath $pointerPath) {
        $pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
        $version = [string]$pointer.model_version
        if (-not [string]::IsNullOrWhiteSpace($version)) { return $version }
    }
    $runs = @(Get-ChildItem -LiteralPath $artifactsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object {
            -not $_.Name.StartsWith(".") -and $_.Name -notlike "*.replaced-*" -and
            (Test-Path -LiteralPath (Join-Path $_.FullName "embedding.pt")) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName "index\index.f32"))
        } |
        Sort-Object LastWriteTime -Descending)
    if ($runs.Count -eq 0) {
        throw "No wanted artwork version: $pointerPath is missing and no artifact with embedding.pt and index\index.f32 exists under $artifactsRoot. Import an artwork bundle in the Toolbox first."
    }
    return $runs[0].Name
}

# Returns the manifest's version when it is at the required schema, else $null.
function Get-CurrentVersion([string]$manifestPath) {
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ([int]$manifest.artwork_mobile_schema_version -ne $RequiredSchema) { return $null }
        $folder = Split-Path -Parent $manifestPath
        foreach ($name in $AppFiles) {
            if (-not (Test-Path -LiteralPath (Join-Path $folder $name))) { return $null }
        }
        return [string]$manifest.model_version
    }
    catch {
        return $null
    }
}

function Resolve-PythonExe([string]$requested) {
    if (-not [string]::IsNullOrWhiteSpace($requested)) {
        return @{ Exe = $requested; PrefixArgs = @() }
    }
    $python = Get-Command "python" -ErrorAction SilentlyContinue
    if ($null -ne $python) { return @{ Exe = "python"; PrefixArgs = @() } }
    $py = Get-Command "py" -ErrorAction SilentlyContinue
    if ($null -ne $py) { return @{ Exe = "py"; PrefixArgs = @("-3") } }
    $venvPython = Join-Path $env:LOCALAPPDATA "Deckino\training-runtime-v3\venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) { return @{ Exe = $venvPython; PrefixArgs = @() } }
    throw "No Python found for export-artwork-mobile. Install Python 3.12 with 'pip install torch onnx onnxruntime pillow numpy', then re-run."
}

$repoRoot = Get-RepoRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repoRoot "data"
}
$artifactsRoot = Join-Path $DataRoot "training\artifacts"
$pointerPath = Join-Path $DataRoot "training\current-artwork.json"
$mobileVersionRoot = Join-Path $DataRoot "training\mobile\artwork"
$appRoot = Join-Path $repoRoot "Deckino.App"
$destination = Join-Path $appRoot "assets\models\artwork"
$appManifestPath = Join-Path $destination "mobile-manifest.json"

try {
    $ModelVersion = Get-WantedVersion $artifactsRoot $pointerPath $ModelVersion
    if ($ModelVersion -notmatch '^[A-Za-z0-9_.-]+$') {
        throw "Invalid artwork model_version '$ModelVersion'."
    }

    if (-not $Force -and ((Get-CurrentVersion $appManifestPath) -eq $ModelVersion)) {
        Write-Host "Artwork recognizer up to date in Expo app: $ModelVersion"
        exit 0
    }

    $source = Join-Path $mobileVersionRoot $ModelVersion
    $mobileManifestPath = Join-Path $source "mobile-manifest.json"
    $mobileReady = (-not $Force) -and ((Get-CurrentVersion $mobileManifestPath) -eq $ModelVersion)
    if (-not $mobileReady) {
        if ($SkipExport) {
            throw "Mobile artwork export for $ModelVersion is missing or predates schema v$RequiredSchema. Re-run without -SkipExport."
        }
        $python = Resolve-PythonExe $PythonExe
        Write-Host "Exporting artwork $ModelVersion to $source (CPU, a few minutes for the parity checks)..."
        $env:PYTHONPATH = Join-Path $repoRoot "Deckino.Toolbox\training\src"
        $env:PYTHONUTF8 = "1"
        $env:PYTHONUNBUFFERED = "1"
        $exportArgs = @() + $python.PrefixArgs + @(
            "-m", "deckino_training", "export-artwork-mobile",
            "--artifacts-root", $artifactsRoot,
            "--output", $source,
            "--model-version", $ModelVersion
        )
        & $python.Exe @exportArgs
        if ($LASTEXITCODE -ne 0) {
            throw "export-artwork-mobile failed with exit code $LASTEXITCODE for $ModelVersion."
        }
        if ((Get-CurrentVersion $mobileManifestPath) -ne $ModelVersion) {
            throw "Export finished but $mobileManifestPath is not a schema v$RequiredSchema export of $ModelVersion."
        }
    }

    Write-Host "Verifying the app's crop and decision code against the $ModelVersion fixture..."
    & node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON (Join-Path $appRoot "scripts\verify-artwork-model.mjs") $source
    if ($LASTEXITCODE -ne 0) {
        throw "verify-artwork-model.mjs failed for $ModelVersion; see $(Join-Path $source 'app-verification.json')."
    }

    Write-Host "Copying artwork $ModelVersion into Deckino.App..."
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    foreach ($name in $AppFiles) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Force
    }
    if ((Get-CurrentVersion $appManifestPath) -ne $ModelVersion) {
        throw "Copy finished but the App artwork manifest does not report $ModelVersion."
    }
    $bytes = (Get-Item -LiteralPath (Join-Path $destination "recognizer.onnx")).Length
    Write-Host ("Artwork recognizer ready in Expo app: $ModelVersion (recognizer.onnx {0:N1} MB)" -f ($bytes / 1MB))
    Write-Host "Metro serves the new recognizer.onnx on restart; no dev-client rebuild is needed for a model change."
    exit 0
}
catch {
    if ($WarnOnly) {
        Write-Warning ("ensure-artwork-mobile: continuing with the previous artwork model. " + $_.Exception.Message)
        exit 0
    }
    throw
}
