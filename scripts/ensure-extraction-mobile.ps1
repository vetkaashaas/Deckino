<#
.SYNOPSIS
  Ensure the Expo app ships the latest imported extraction model.

.DESCRIPTION
  Bridges the two manual steps between a Toolbox import and the phone:
  imported .pt artifacts -> mobile ONNX export -> Deckino.App assets.

  1. Resolves the wanted version from -ModelVersion, else
     data/training/current-extraction.json, else the newest
     data/training/artifacts/extractor-run-* folder with extractor.pt.
  2. If Deckino.App/assets/models/extractor/mobile-manifest.json already
     reports that version and the App has its refiner.onnx, exits 0
     without doing anything.
  3. Otherwise runs export-extraction-mobile on CPU into
     data/training/mobile/extractor/<version>/ (skipped with -SkipExport),
     also when the existing export predates the frame-input refiner.
  4. Runs Deckino.App/scripts/verify-extractor-model.mjs: the app's
     TypeScript corner refinement must reproduce the export's fixture.
  5. Copies the mobile export into the App via copy-extractor-to-app.ps1.

  Called automatically by deckino-android-dev.ps1. Safe to run twice;
  the second run is a no-op. GPU is not required.

.PARAMETER ModelVersion
  Artifact / export folder name. Default: current-extraction.json pointer,
  else newest extractor-run-* with extractor.pt.

.PARAMETER DataRoot
  Deckino data folder. Default: <repo>\data.

.PARAMETER SkipExport
  Do not run export-extraction-mobile; only copy the existing mobile
  export into the App. Fails when the mobile export is missing or stale.

.PARAMETER Force
  Re-run the export and copy even when the App already reports the
  wanted version (e.g. after an exporter fix).

.PARAMETER WarnOnly
  On export/copy failure, print a warning and exit 0 instead of throwing,
  so the caller can still start Metro with the previous model.

.PARAMETER PythonExe
  Python executable for the export. Default: "python", then "py -3",
  then the Toolbox venv python. Must have torch, onnx and onnxruntime.
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
        Where-Object { $_.Name -like "extractor-run-*" -and (Test-Path -LiteralPath (Join-Path $_.FullName "extractor.pt")) } |
        Sort-Object Name -Descending)
    if ($runs.Count -eq 0) {
        throw "No wanted extractor version: $pointerPath is missing and no extractor-run-* with extractor.pt exists under $artifactsRoot."
    }
    return $runs[0].Name
}

function Get-ManifestVersion([string]$manifestPath) {
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        return [string]$manifest.model_version
    }
    catch {
        return $null
    }
}

function Resolve-PythonExe([string]$requested, [string]$repoRoot) {
    if (-not [string]::IsNullOrWhiteSpace($requested)) {
        return @{ Exe = $requested; PrefixArgs = @() }
    }
    $python = Get-Command "python" -ErrorAction SilentlyContinue
    if ($null -ne $python) { return @{ Exe = "python"; PrefixArgs = @() } }
    $py = Get-Command "py" -ErrorAction SilentlyContinue
    if ($null -ne $py) { return @{ Exe = "py"; PrefixArgs = @("-3") } }
    $venvPython = Join-Path $env:LOCALAPPDATA "Deckino\training-runtime-v3\venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) { return @{ Exe = $venvPython; PrefixArgs = @() } }
    throw ("No Python found for export-extraction-mobile. Install Python 3.12 with " +
        "'pip install torch onnx onnxruntime', then re-run. " +
        "(Toolbox venv at $venvPython lacks onnx/onnxruntime.)")
}

$repoRoot = Get-RepoRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repoRoot "data"
}
$artifactsRoot = Join-Path $DataRoot "training\artifacts"
$pointerPath = Join-Path $DataRoot "training\current-extraction.json"
$mobileVersionRoot = Join-Path $DataRoot "training\mobile\extractor"
$appRoot = Join-Path $repoRoot "Deckino.App"
$appManifestPath = Join-Path $appRoot "assets\models\extractor\mobile-manifest.json"

try {
    $ModelVersion = Get-WantedVersion $artifactsRoot $pointerPath $ModelVersion
    if ($ModelVersion -notmatch '^[A-Za-z0-9_-]+$') {
        throw "Invalid model_version '$ModelVersion'."
    }

    $appVersion = Get-ManifestVersion $appManifestPath
    $appHasRefiner = Test-Path -LiteralPath (Join-Path $appRoot "assets\models\extractor\refiner.onnx")
    if (-not $Force -and ($appVersion -eq $ModelVersion) -and $appHasRefiner) {
        Write-Host "Extractor up to date in Expo app: $ModelVersion"
        exit 0
    }

    $mobileManifestPath = Join-Path $mobileVersionRoot (Join-Path $ModelVersion "mobile-manifest.json")
    $mobileVersion = Get-ManifestVersion $mobileManifestPath
    # Exports before the frame-input refiner (2026-10-12) have no refiner fixture and must be redone.
    $hasRefinerFixture = Test-Path -LiteralPath (Join-Path $mobileVersionRoot (Join-Path $ModelVersion "refiner-fixture.json"))
    $mobileReady = ((-not $Force) -and ($mobileVersion -eq $ModelVersion) -and $hasRefinerFixture)

    if (-not $mobileReady) {
        if ($SkipExport) {
            $why = if ($mobileVersion -eq $ModelVersion) { "predates the frame-input refiner (no refiner-fixture.json)" }
                else { "is missing (found: '" + $mobileVersion + "')" }
            throw ("Mobile export for $ModelVersion $why. " +
                "Re-run without -SkipExport to run export-extraction-mobile.")
        }
        $python = Resolve-PythonExe $PythonExe $repoRoot
        $trainingSrc = Join-Path $repoRoot "Deckino.Toolbox\training\src"
        $output = Join-Path $mobileVersionRoot $ModelVersion
        Write-Host "Exporting $ModelVersion to $output (CPU, no GPU needed)..."
        $env:PYTHONPATH = $trainingSrc
        $env:PYTHONUTF8 = "1"
        $env:PYTHONUNBUFFERED = "1"
        $exportArgs = @() + $python.PrefixArgs + @(
            "-m", "deckino_training", "export-extraction-mobile",
            "--artifacts-root", $artifactsRoot,
            "--output", $output,
            "--model-version", $ModelVersion,
            "--device", "cpu"
        )
        & $python.Exe @exportArgs
        if ($LASTEXITCODE -ne 0) {
            throw "export-extraction-mobile failed with exit code $LASTEXITCODE for $ModelVersion."
        }
        $mobileVersion = Get-ManifestVersion $mobileManifestPath
        if ($mobileVersion -ne $ModelVersion) {
            throw "Export finished but $mobileManifestPath still reports '$mobileVersion'."
        }
    }

    $source = Join-Path $mobileVersionRoot $ModelVersion
    Write-Host "Verifying the app's corner refinement against the $ModelVersion fixture..."
    & node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON (Join-Path $appRoot "scripts\verify-extractor-model.mjs") $source
    if ($LASTEXITCODE -ne 0) {
        throw "verify-extractor-model.mjs failed for $ModelVersion; see $(Join-Path $source 'app-verification.json')."
    }

    Write-Host "Copying $ModelVersion into Deckino.App..."
    & (Join-Path $PSScriptRoot "copy-extractor-to-app.ps1") -ModelVersion $ModelVersion -DataRoot $DataRoot
    if ($LASTEXITCODE -ne 0) {
        throw "copy-extractor-to-app.ps1 failed with exit code $LASTEXITCODE."
    }

    $appVersion = Get-ManifestVersion $appManifestPath
    if ($appVersion -ne $ModelVersion) {
        throw "Copy finished but the App manifest still reports '$appVersion'."
    }
    Write-Host "Extractor ready in Expo app: $ModelVersion"
    Write-Host "Metro serves the new extractor.onnx on restart. If Scan still shows an older 'extractor: ...', rebuild the dev client: npm run android:device in Deckino.App."
    exit 0
}
catch {
    if ($WarnOnly) {
        Write-Warning ("ensure-extraction-mobile: continuing with previous model. " + $_.Exception.Message)
        exit 0
    }
    throw
}
