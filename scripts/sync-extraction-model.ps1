<#
.SYNOPSIS
  Copy a trained card-extraction model between the CUDA training PC and a build PC.

.DESCRIPTION
  Training PC:
    powershell -File .\scripts\sync-extraction-model.ps1 -Pack
    Copy data\training\handoff\deckino-extraction-handoff-latest.zip to the other computer.

  Build PC:
    Place the ZIP in data\training\incoming\ (or pass -Path)
    powershell -File .\scripts\sync-extraction-model.ps1

  The script does not need an NVIDIA GPU. It writes data\training\current-extraction.json
  so other tools (and agents) can find the active extractor.pt, preprocessing, and thresholds.

.PARAMETER Pack
  Create a compact handoff ZIP from local artifacts.

.PARAMETER Path
  ZIP to import. If omitted, uses the newest ZIP in data\training\incoming, then
  data\training\handoff\deckino-extraction-handoff-latest.zip.

.PARAMETER ModelVersion
  Artifact folder name to pack. Default: newest extractor-run-* that has extractor.pt.

.PARAMETER DataRoot
  Deckino data folder. Default: <repo>\data.
#>
[CmdletBinding()]
param(
    [switch]$Pack,
    [string]$Path,
    [string]$ModelVersion,
    [string]$DataRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-RepoRoot {
    $dir = Get-Item -LiteralPath $PSScriptRoot
    while ($null -ne $dir) {
        if (Test-Path -LiteralPath (Join-Path $dir.FullName ".git")) { return $dir.FullName }
        $dir = $dir.Parent
    }
    throw "Could not find the Deckino repository root from $PSScriptRoot."
}

function Get-Sha256Hex([byte[]]$bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function ConvertTo-RedactedText([string]$text) {
    return [regex]::Replace($text, '(?i)\b[A-Z]:(?:\\+|/+)[^\"\r\n]*', "<ABSOLUTE_PATH>")
}

function ConvertTo-ZipBytes([string]$filePath, [string]$entryName) {
    $isText = $entryName.StartsWith("logs/") -or
        $entryName.EndsWith(".json", [StringComparison]::OrdinalIgnoreCase) -or
        $entryName.EndsWith(".jsonl", [StringComparison]::OrdinalIgnoreCase)
    if ($isText) {
        $text = [System.IO.File]::ReadAllText($filePath)
        return [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-RedactedText $text))
    }
    return [System.IO.File]::ReadAllBytes($filePath)
}

function Get-LatestExtractorVersion([string]$artifactsRoot) {
    if (-not (Test-Path -LiteralPath $artifactsRoot)) {
        throw "No extraction artifacts were found at $artifactsRoot."
    }
    $candidates = Get-ChildItem -LiteralPath $artifactsRoot -Directory |
        Where-Object { $_.Name -like "extractor-run-*" -and (Test-Path -LiteralPath (Join-Path $_.FullName "extractor.pt")) } |
        Sort-Object Name -Descending
    if (-not $candidates) {
        throw "No extractor-run-* folder with extractor.pt was found in $artifactsRoot."
    }
    return $candidates[0].Name
}

$repoRoot = Get-RepoRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repoRoot "data"
}
$trainingRoot = Join-Path $DataRoot "training"
$artifactsRoot = Join-Path $trainingRoot "artifacts"
$handoffRoot = Join-Path $trainingRoot "handoff"
$incomingRoot = Join-Path $trainingRoot "incoming"
$pointerPath = Join-Path $trainingRoot "current-extraction.json"

$required = @(
    "best.pt", "extractor.pt", "config.json", "preprocessing.json", "thresholds.json",
    "evaluation.json", "extraction-report.json"
)
$optional = @("calibration.json", "checkpoint-selection.json", "workflow-state.json")

function Write-CurrentPointer([string]$version, [string]$sourceZip, [string]$sourceKind) {
    $artifactRoot = Join-Path $artifactsRoot $version
    $configPath = Join-Path $artifactRoot "config.json"
    $architecture = $null
    $inputSize = $null
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($null -ne $config.architecture) { $architecture = [string]$config.architecture }
        if ($null -ne $config.input_size) { $inputSize = [int]$config.input_size }
    }
    $files = [ordered]@{}
    $named = @{
        checkpoint = "extractor.pt"
        best_checkpoint = "best.pt"
        config = "config.json"
        preprocessing = "preprocessing.json"
        thresholds = "thresholds.json"
        evaluation = "evaluation.json"
    }
    foreach ($key in $named.Keys) {
        if (Test-Path -LiteralPath (Join-Path $artifactRoot $named[$key])) {
            $files[$key] = $named[$key]
        }
    }
    $dataFull = [System.IO.Path]::GetFullPath($DataRoot)
    $zipFull = [System.IO.Path]::GetFullPath($sourceZip)
    $sourceZipRelative = if ($zipFull.StartsWith($dataFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        $zipFull.Substring($dataFull.Length).TrimStart("\", "/").Replace("\", "/")
    } else {
        [System.IO.Path]::GetFileName($zipFull)
    }
    $pointer = [ordered]@{
        pointer_schema_version = 1
        kind = "card-extraction"
        model_version = $version
        architecture = $architecture
        input_size = $inputSize
        artifact_root = ("training/artifacts/" + $version)
        files = $files
        updated_utc = [DateTime]::UtcNow.ToString("o")
        source_zip = $sourceZipRelative
        source_kind = $sourceKind
    }
    New-Item -ItemType Directory -Force -Path $trainingRoot | Out-Null
    $json = $pointer | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($pointerPath, $json + "`n")
}

if ($Pack) {
    if ([string]::IsNullOrWhiteSpace($ModelVersion)) {
        $ModelVersion = Get-LatestExtractorVersion $artifactsRoot
    }
    $artifactRoot = Join-Path $artifactsRoot $ModelVersion
    New-Item -ItemType Directory -Force -Path $handoffRoot | Out-Null
    $entries = @()
    foreach ($relative in $required) {
        $source = Join-Path $artifactRoot $relative
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Cannot pack extraction handoff: $relative is missing from $artifactRoot."
        }
        $entries += [pscustomobject]@{ Path = $source; Entry = "artifacts/$relative" }
    }
    foreach ($relative in $optional) {
        $source = Join-Path $artifactRoot $relative
        if (Test-Path -LiteralPath $source) {
            $entries += [pscustomobject]@{ Path = $source; Entry = "artifacts/$relative" }
        }
    }
    $reportPath = Join-Path $artifactRoot "extraction-report.json"
    $datasetVersion = $null
    if (Test-Path -LiteralPath $reportPath) {
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        if ($null -ne $report.dataset_version) { $datasetVersion = [string]$report.dataset_version }
    }
    $config = Get-Content -LiteralPath (Join-Path $artifactRoot "config.json") -Raw | ConvertFrom-Json
    $schema = 1
    if ($null -ne $config.artifact_schema_version) { $schema = [int]$config.artifact_schema_version }
    $created = [DateTime]::UtcNow.ToString("o")
    $metadataObject = [ordered]@{
        export_schema_version = 1
        artifact_schema_version = $schema
        model_version = $ModelVersion
        dataset_version = $datasetVersion
        identity = $false
        artifact_kind = "card-extraction-handoff"
        created_utc = $created
    }
    $metadataBytes = [System.Text.Encoding]::UTF8.GetBytes(($metadataObject | ConvertTo-Json -Depth 5) + "`n")

    $zipPath = Join-Path $handoffRoot ("deckino-extraction-handoff-" + $ModelVersion + ".zip")
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
    $checksums = [ordered]@{}
    $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in $entries | Sort-Object Entry) {
            $bytes = ConvertTo-ZipBytes $item.Path $item.Entry
            $checksums[$item.Entry] = Get-Sha256Hex $bytes
            $entry = $archive.CreateEntry($item.Entry, [System.IO.Compression.CompressionLevel]::Optimal)
            $stream = $entry.Open()
            try { $stream.Write($bytes, 0, $bytes.Length) }
            finally { $stream.Dispose() }
        }
        $checksums["metadata.json"] = Get-Sha256Hex $metadataBytes
        $metaEntry = $archive.CreateEntry("metadata.json", [System.IO.Compression.CompressionLevel]::Optimal)
        $metaStream = $metaEntry.Open()
        try { $metaStream.Write($metadataBytes, 0, $metadataBytes.Length) }
        finally { $metaStream.Dispose() }
        $sumLines = foreach ($key in $checksums.Keys) { "{0}  {1}" -f $checksums[$key], $key }
        $sumBytes = [System.Text.Encoding]::UTF8.GetBytes((($sumLines -join "`n") + "`n"))
        $sumEntry = $archive.CreateEntry("SHA256SUMS", [System.IO.Compression.CompressionLevel]::Optimal)
        $sumStream = $sumEntry.Open()
        try { $sumStream.Write($sumBytes, 0, $sumBytes.Length) }
        finally { $sumStream.Dispose() }
    }
    finally { $archive.Dispose() }

    $latest = Join-Path $handoffRoot "deckino-extraction-handoff-latest.zip"
    Copy-Item -LiteralPath $zipPath -Destination $latest -Force
    Write-CurrentPointer $ModelVersion $zipPath "card-extraction-handoff"
    Write-Host "Packed $zipPath"
    Write-Host "Also wrote $latest"
    Write-Host "Copy that ZIP to the other PC and run this script without -Pack."
    exit 0
}

New-Item -ItemType Directory -Force -Path $incomingRoot | Out-Null
if ([string]::IsNullOrWhiteSpace($Path)) {
    $incomingZips = @(Get-ChildItem -LiteralPath $incomingRoot -File -Filter *.zip -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending)
    if ($incomingZips.Count -gt 0) {
        $Path = $incomingZips[0].FullName
    }
    else {
        $latest = Join-Path $handoffRoot "deckino-extraction-handoff-latest.zip"
        if (Test-Path -LiteralPath $latest) { $Path = $latest }
    }
}
if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    throw "No extraction ZIP found. Pass -Path or drop a file in $incomingRoot."
}

$Path = [System.IO.Path]::GetFullPath($Path)
$archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
try {
    $entries = @{}
    foreach ($entry in $archive.Entries) {
        if (-not [string]::IsNullOrEmpty($entry.Name)) { $entries[$entry.FullName] = $entry }
    }
    if (-not $entries.ContainsKey("SHA256SUMS")) { throw "ZIP is missing SHA256SUMS." }
    $sumReader = New-Object System.IO.StreamReader($entries["SHA256SUMS"].Open())
    try { $sumText = $sumReader.ReadToEnd() }
    finally { $sumReader.Dispose() }
    $expected = @{}
    foreach ($line in ($sumText -split "`n")) {
        $line = $line.Trim()
        if ($line.Length -eq 0) { continue }
        if ($line.Length -lt 67 -or $line.Substring(64, 2) -ne "  ") {
            throw "SHA256SUMS contains an invalid line."
        }
        $hash = $line.Substring(0, 64)
        $name = $line.Substring(66)
        if ($name.Contains("..")) { throw "SHA256SUMS contains an unsafe path." }
        $expected[$name] = $hash
    }
    $payload = @($entries.Keys | Where-Object { $_ -ne "SHA256SUMS" })
    foreach ($name in $payload) {
        if (-not $expected.ContainsKey($name)) { throw "ZIP contains unchecked entry $name." }
    }
    foreach ($name in $expected.Keys) {
        if (-not $entries.ContainsKey($name)) { throw "ZIP is missing checksummed entry $name." }
        $stream = $entries[$name].Open()
        try {
            $memory = New-Object System.IO.MemoryStream
            $stream.CopyTo($memory)
            $actual = Get-Sha256Hex $memory.ToArray()
        }
        finally { $stream.Dispose() }
        if ($actual -ne $expected[$name]) { throw "Checksum mismatch for $name." }
    }
    if (-not $entries.ContainsKey("metadata.json")) { throw "ZIP is missing metadata.json." }
    $metaReader = New-Object System.IO.StreamReader($entries["metadata.json"].Open())
    try { $metadata = $metaReader.ReadToEnd() | ConvertFrom-Json }
    finally { $metaReader.Dispose() }
    $kind = [string]$metadata.artifact_kind
    if ($kind -ne "card-extraction" -and $kind -ne "card-extraction-handoff") {
        throw "ZIP is not an extraction bundle: $kind"
    }
    $ModelVersion = [string]$metadata.model_version
    if ([string]::IsNullOrWhiteSpace($ModelVersion) -or $ModelVersion -notmatch '^[A-Za-z0-9_-]+$') {
        throw "Extraction bundle metadata has an invalid model_version."
    }
    $artifactRoot = Join-Path $artifactsRoot $ModelVersion
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
    $extracted = 0
    foreach ($name in $entries.Keys) {
        if (-not $name.StartsWith("artifacts/")) { continue }
        $relative = $name.Substring("artifacts/".Length).Replace("/", [IO.Path]::DirectorySeparatorChar)
        if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains("..")) {
            throw "ZIP contains an unsafe path: $name"
        }
        $destination = Join-Path $artifactRoot $relative
        $destinationFull = [System.IO.Path]::GetFullPath($destination)
        $rootFull = [System.IO.Path]::GetFullPath($artifactRoot)
        if (-not $destinationFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
            throw "ZIP would write outside the artifact folder: $name"
        }
        New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($destinationFull)) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[$name], $destinationFull, $true)
        $extracted++
    }
}
finally { $archive.Dispose() }

foreach ($requiredName in @("extractor.pt", "config.json", "preprocessing.json", "thresholds.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $artifactRoot $requiredName))) {
        throw "Imported bundle is missing $requiredName."
    }
}
if ($extracted -le 0) { throw "ZIP did not contain any artifacts." }
Write-CurrentPointer $ModelVersion $Path $kind
Write-Host "Imported $ModelVersion ($extracted files) into $artifactRoot"
Write-Host "Current pointer: $pointerPath"
