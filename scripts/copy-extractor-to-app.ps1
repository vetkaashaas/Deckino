<#
.SYNOPSIS
  Copy the latest mobile extractor bundle into Deckino.App/assets/models/extractor.

.PARAMETER ModelVersion
  Artifact / export folder name. Default: data/training/current-extraction.json, else newest export.
#>
[CmdletBinding()]
param(
    [string]$ModelVersion,
    [string]$DataRoot
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

$repoRoot = Get-RepoRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repoRoot "data"
}
$mobileRoot = Join-Path $DataRoot "training\mobile\extractor"
$pointerPath = Join-Path $DataRoot "training\current-extraction.json"
if ([string]::IsNullOrWhiteSpace($ModelVersion) -and (Test-Path -LiteralPath $pointerPath)) {
    $pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
    $ModelVersion = [string]$pointer.model_version
}
if ([string]::IsNullOrWhiteSpace($ModelVersion)) {
    $exports = @(Get-ChildItem -LiteralPath $mobileRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending)
    if ($exports.Count -eq 0) {
        throw "No mobile extractor export found under $mobileRoot. Run export-extraction-mobile first."
    }
    $ModelVersion = $exports[0].Name
}

$source = Join-Path $mobileRoot $ModelVersion
if (-not (Test-Path -LiteralPath (Join-Path $source "mobile-manifest.json"))) {
    throw "No mobile-manifest.json in $source. Run: deckino-training export-extraction-mobile ..."
}

$destination = Join-Path $repoRoot "Deckino.App\assets\models\extractor"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($name in @(
    "extractor.tflite", "extractor.onnx", "mobile-manifest.json",
    "preprocessing.json", "thresholds.json", "config.json"
)) {
    $file = Join-Path $source $name
    if (Test-Path -LiteralPath $file) {
        Copy-Item -LiteralPath $file -Destination (Join-Path $destination $name) -Force
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $destination "mobile-manifest.json") -Raw | ConvertFrom-Json
$hasTflite = Test-Path -LiteralPath (Join-Path $destination "extractor.tflite")
Write-Host "Copied $ModelVersion -> $destination"
Write-Host ("tflite=" + $(if ($hasTflite) { "extractor.tflite" } else { "missing" }) + " onnx=" + $manifest.onnx)
if (-not $hasTflite) {
    Write-Host "No TFLite file yet. The Scan overlay needs extractor.tflite; ONNX is the desktop/parity artifact."
}
