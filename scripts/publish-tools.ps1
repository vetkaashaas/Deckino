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

Compress-Archive -Path (Join-Path $publishRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "Created $zipPath"
