<#
.SYNOPSIS
  Publishes the Toolbox (Deckino.Tools) as a Velopack release and uploads it to the bucket's toolbox/ prefix.

.DESCRIPTION
  Installed copies (from Setup.exe) offer the new release on their sidebar's update button at their next start, or
  within a minute if open (app/src/updates.rs). The pack id, main exe name and prefix are the C# Toolbox's, so its
  installs update into this one. The C runtime is linked statically (.cargo/config.toml) because updates never install
  prerequisites. The upload uses the bucket connection saved on this PC's Dataset Sync page. The release, Setup.exe
  included, is also left in publish\releases.

.PARAMETER SkipUpload
  Pack the release without uploading it.
#>
[CmdletBinding()]
param([switch]$SkipUpload)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$codeRoot = Split-Path -Parent $projectRoot
$trainingRoot = Join-Path $projectRoot "training"
$publishRoot = Join-Path $projectRoot "publish\Deckino.Toolbox-win-x64"
$releasesRoot = Join-Path $projectRoot "publish\releases"

# SemVer without leading zeros, rising with time: 2026.1019.930 is 19 October 2026 at 09:30 (UTC).
$now = (Get-Date).ToUniversalTime()
$version = "{0}.{1}{2:00}.{3}" -f $now.Year, $now.Month, $now.Day, ($now.Hour * 100 + $now.Minute)

Push-Location $projectRoot
try {
    cargo build --release -p deckino-tools
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

if (Test-Path -LiteralPath $publishRoot) { Remove-Item -LiteralPath $publishRoot -Recurse -Force }
New-Item -ItemType Directory -Force $publishRoot | Out-Null
# Named as the C# Toolbox's exe: its installs launch the app by that name.
Copy-Item (Join-Path $projectRoot "target\release\deckino-tools.exe") (Join-Path $publishRoot "Deckino.Toolbox.exe")

# The training package beside the exe (TrainingPaths::bundled_project_root): sources, requirements, benchmarks, tools.
$training = Join-Path $publishRoot "training"
New-Item -ItemType Directory -Force (Join-Path $training "runtime-tools"), (Join-Path $training "benchmarks") | Out-Null
foreach ($file in "pyproject.toml", "requirements-cuda.txt", "README.md") { Copy-Item (Join-Path $trainingRoot $file) $training }
Copy-Item (Join-Path $trainingRoot "benchmarks\*.json") (Join-Path $training "benchmarks")
Copy-Item (Join-Path $trainingRoot "runtime-tools\*.ps1") (Join-Path $training "runtime-tools")
Get-ChildItem (Join-Path $trainingRoot "src") -Recurse -Filter *.py |
    Where-Object { $_.FullName -notmatch '([\\/])(tests|__pycache__|\.venv)([\\/]|$)' } |
    ForEach-Object {
        $target = Join-Path $training ($_.FullName.Substring($trainingRoot.Length + 1))
        New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
        Copy-Item $_.FullName $target
    }

$requiredFiles = @(
    "Deckino.Toolbox.exe",
    "training\src\deckino_training\cli.py",
    "training\src\deckino_training\extraction_suggestion.py",
    "training\benchmarks\artwork-real-v1.json",
    "training\requirements-cuda.txt",
    "training\runtime-tools\verify-python-signature.ps1"
)
$missingFiles = $requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $publishRoot $_) -PathType Leaf) }
if ($missingFiles) { throw "Publish is missing required files: $($missingFiles -join ', ')" }

Push-Location $codeRoot
try {
    dotnet tool restore | Out-Null
    dotnet vpk pack `
        --packId Deckino.Toolbox `
        --packVersion $version `
        --packTitle "Deckino Toolbox" `
        --packAuthors "Deckino" `
        --packDir $publishRoot `
        --mainExe Deckino.Toolbox.exe `
        --icon (Join-Path $projectRoot "app\assets\deckino.ico") `
        --outputDir $releasesRoot
    if ($LASTEXITCODE -ne 0) { throw "vpk pack failed with exit code $LASTEXITCODE." }

    if (-not $SkipUpload) {
        # The Toolbox's own bucket connection (DPAPI), readable only by this Windows user.
        $credentialsPath = Join-Path $env:LOCALAPPDATA "Deckino\dataset-sync.credentials"
        if (-not (Test-Path -LiteralPath $credentialsPath)) {
            throw "No bucket connection on this PC. Save one on the Toolbox's Dataset Sync page, or pass -SkipUpload."
        }
        Add-Type -AssemblyName System.Security
        $clear = [Security.Cryptography.ProtectedData]::Unprotect(
            [IO.File]::ReadAllBytes($credentialsPath),
            [Text.Encoding]::UTF8.GetBytes("Deckino.CameraDatasetSync.v1"),
            [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $bucket = [Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json
        $uploadArgs = @(
            "vpk", "upload", "s3",
            "--outputDir", $releasesRoot,
            "--endpoint", $bucket.Endpoint,
            "--bucket", $bucket.Bucket,
            "--region", $bucket.Region,
            "--prefix", "toolbox",
            "--keepMaxReleases", "5"
        )
        if (-not $bucket.ForcePathStyle) { $uploadArgs += "--disablePathStyle" }
        # The keys go through the environment (the AWS SDK reads them), not the command line other processes can read.
        $env:AWS_ACCESS_KEY_ID = $bucket.AccessKeyId
        $env:AWS_SECRET_ACCESS_KEY = $bucket.SecretAccessKey
        try { dotnet @uploadArgs }
        finally { Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue }
        if ($LASTEXITCODE -ne 0) { throw "vpk upload failed with exit code $LASTEXITCODE." }
    }
}
finally { Pop-Location }

Write-Host ""
Write-Host "Deckino Toolbox $version published" -ForegroundColor Green
Write-Host "Release : $releasesRoot"
Write-Host "Setup   : $(Join-Path $releasesRoot 'Deckino.Toolbox-win-Setup.exe')"
if ($SkipUpload) { Write-Host "Not uploaded (-SkipUpload)." -ForegroundColor Yellow }
else { Write-Host "Uploaded to the bucket's toolbox/ prefix; installed copies offer it on their sidebar." }
