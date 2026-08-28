[CmdletBinding()]
param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repositoryRoot "Deckino.Tools\Deckino.Tools.csproj"
$publishRoot = Join-Path $repositoryRoot "publish\Deckino.Tools-win-x64"
$zipPath = Join-Path $repositoryRoot "publish\Deckino.Tools-win-x64.zip"

if (Test-Path -LiteralPath $publishRoot) {
    Remove-Item -LiteralPath $publishRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

dotnet publish $projectPath `
    --configuration $Configuration `
    --runtime win-x64 `
    --self-contained true `
    --output $publishRoot `
    -p:PublishSingleFile=false `
    -p:UseSharedCompilation=false `
    -m:1
if ($LASTEXITCODE -ne 0) {
    throw "Deckino.Tools publish failed with exit code $LASTEXITCODE."
}

$forbidden = Get-ChildItem -LiteralPath $publishRoot -Recurse -Force | Where-Object {
    $_.FullName -match '([\\/])(data|tests|\.venv|__pycache__|\.pytest_cache)([\\/]|$)' -or
    $_.Name -match 'directml|rocm'
}
if ($forbidden) {
    throw "Portable publish contains forbidden files: $($forbidden.FullName -join ', ')"
}

$requiredFiles = @(
    "Deckino.Tools.exe",
    "training\src\deckino_training\cli.py",
    "training\src\deckino_training\extraction.py",
    "training\src\deckino_training\extraction_groups.py",
    "training\src\deckino_training\extraction_network.py",
    "training\src\deckino_training\extraction_augmentation.py",
    "training\src\deckino_training\extraction_training.py",
    "training\src\deckino_training\extraction_evaluation.py",
    "training\requirements-cuda.txt"
)
$missingFiles = $requiredFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $publishRoot $_) -PathType Leaf)
}
if ($missingFiles) {
    throw "Portable publish is missing required files: $($missingFiles -join ', ')"
}

Compress-Archive -Path (Join-Path $publishRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $archiveEntries = $archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) }
    $normalizedEntries = $archiveEntries | ForEach-Object {
        [PSCustomObject]@{
            Entry = $_
            FullName = $_.FullName.Replace('\', '/')
        }
    }
    $duplicateEntries = $normalizedEntries |
        Group-Object -Property FullName |
        Where-Object Count -gt 1
    if ($duplicateEntries) {
        throw "ZIP contains duplicate entries: $($duplicateEntries.Name -join ', ')"
    }

    $forbiddenEntries = $normalizedEntries | Where-Object {
        $_.FullName -match '(^|/)(data|tests|\.venv|__pycache__|\.pytest_cache)(/|$)' -or
        $_.Entry.Name -match 'directml|rocm'
    }
    if ($forbiddenEntries) {
        throw "ZIP contains forbidden entries: $($forbiddenEntries.FullName -join ', ')"
    }

    $requiredZipEntries = $requiredFiles | ForEach-Object { $_.Replace('\', '/') }
    $archiveEntryNames = $normalizedEntries.FullName
    $missingZipEntries = $requiredZipEntries | Where-Object {
        $archiveEntryNames -notcontains $_
    }
    if ($missingZipEntries) {
        throw "ZIP is missing required entries: $($missingZipEntries -join ', ')"
    }

    $entryCount = $archiveEntries.Count
}
finally {
    $archive.Dispose()
}

$zipFile = Get-Item -LiteralPath $zipPath
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host ""
Write-Host "Deckino.Tools publish complete" -ForegroundColor Green
Write-Host "Folder : $publishRoot"
Write-Host "ZIP    : $zipPath"
Write-Host "Size   : $($zipFile.Length) bytes"
Write-Host "Entries: $entryCount"
Write-Host "SHA-256: $zipHash"
