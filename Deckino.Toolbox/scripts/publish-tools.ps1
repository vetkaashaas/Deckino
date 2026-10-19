<#
.SYNOPSIS
  Publishes the Toolbox as a Velopack release and uploads it to the bucket's toolbox/ prefix.

.DESCRIPTION
  Installed Toolboxes (from Setup.exe) offer the new release on their sidebar's update button at their next start, or
  within six hours if they are open (ViewModels/ShellViewModel.cs). The upload uses the bucket connection saved on this PC's Dataset Sync page.
  The release, Setup.exe included, is also left in publish\releases.

.PARAMETER SkipUpload
  Pack the release without uploading it.
#>
[CmdletBinding()]
param(
    [string]$Configuration = "Release",
    [switch]$SkipUpload
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $projectRoot "Deckino.Toolbox.csproj"
$publishRoot = Join-Path $projectRoot "publish\Deckino.Toolbox-win-x64"
$releasesRoot = Join-Path $projectRoot "publish\releases"
$toolsManifestRoot = Split-Path -Parent $projectRoot

# SemVer without leading zeros, rising with time: 2026.1019.930 is 19 October 2026 at 09:30 (UTC).
$now = (Get-Date).ToUniversalTime()
$version = "{0}.{1}{2:00}.{3}" -f $now.Year, $now.Month, $now.Day, ($now.Hour * 100 + $now.Minute)

& (Join-Path $PSScriptRoot "fetch-ffmpeg.ps1")

if (Test-Path -LiteralPath $publishRoot) {
    Remove-Item -LiteralPath $publishRoot -Recurse -Force
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
    throw "Deckino.Toolbox publish failed with exit code $LASTEXITCODE."
}

$forbidden = Get-ChildItem -LiteralPath $publishRoot -Recurse -Force | Where-Object {
    $_.FullName -match '([\\/])(data|tests|\.venv|__pycache__|\.pytest_cache)([\\/]|$)' -or
    ($_.Name -match 'directml|rocm' -and $_.FullName -ne (Join-Path $publishRoot "DirectML.dll"))
}
# The root DirectML.dll is the Windows App SDK's own runtime (WinUI); the check keeps DirectML/ROCm torch out of training.
if ($forbidden) {
    throw "Publish contains forbidden files: $($forbidden.FullName -join ', ')"
}

$requiredFiles = @(
    "Deckino.Toolbox.exe",
    "training\src\deckino_training\cli.py",
    "training\src\deckino_training\extraction.py",
    "training\src\deckino_training\extraction_diagnostics.py",
    "training\src\deckino_training\extraction_suggestion.py",
    "training\src\deckino_training\extraction_groups.py",
    "training\src\deckino_training\extraction_network.py",
    "training\src\deckino_training\extraction_augmentation.py",
    "training\src\deckino_training\extraction_training.py",
    "training\src\deckino_training\extraction_evaluation.py",
    "training\src\deckino_training\extraction_refiner.py",
    "training\src\deckino_training\extraction_audit.py",
    "training\src\deckino_training\artwork_mobile.py",
    "training\src\deckino_training\artwork_camera_probe.py",
    "training\src\deckino_training\artwork_real_photos.py",
    "training\src\deckino_training\artwork_benchmark.py",
    "training\benchmarks\artwork-real-v1.json",
    "training\src\deckino_training\camera_augmentation.py",
    "training\src\deckino_training\artwork_augmentation_preview.py",
    "training\requirements-cuda.txt",
    "tools\ffmpeg\win-x64\ffmpeg.exe",
    "tools\ffmpeg\win-x64\ffprobe.exe",
    "tools\ffmpeg\win-x64\avcodec-63.dll",
    "tools\ffmpeg\win-x64\avdevice-63.dll",
    "tools\ffmpeg\win-x64\avfilter-12.dll",
    "tools\ffmpeg\win-x64\avformat-63.dll",
    "tools\ffmpeg\win-x64\avutil-61.dll",
    "tools\ffmpeg\win-x64\swresample-7.dll",
    "tools\ffmpeg\win-x64\swscale-10.dll",
    "tools\ffmpeg\win-x64\LICENSE.txt",
    "tools\ffmpeg\win-x64\THIRD-PARTY-NOTICES.txt",
    "tools\ffmpeg\win-x64\runtime.json"
)
$missingFiles = $requiredFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $publishRoot $_) -PathType Leaf)
}
if ($missingFiles) {
    throw "Publish is missing required files: $($missingFiles -join ', ')"
}

Push-Location $toolsManifestRoot
try {
    dotnet tool restore | Out-Null
    dotnet vpk pack `
        --packId Deckino.Toolbox `
        --packVersion $version `
        --packTitle "Deckino Toolbox" `
        --packAuthors "Deckino" `
        --packDir $publishRoot `
        --mainExe Deckino.Toolbox.exe `
        --outputDir $releasesRoot
    if ($LASTEXITCODE -ne 0) {
        throw "vpk pack failed with exit code $LASTEXITCODE."
    }

    if (-not $SkipUpload) {
        # The Toolbox's own bucket connection (DpapiSyncCredentialStore), readable only by this Windows user.
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
        try {
            dotnet @uploadArgs
        }
        finally {
            Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
        }
        if ($LASTEXITCODE -ne 0) {
            throw "vpk upload failed with exit code $LASTEXITCODE."
        }
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Deckino.Toolbox $version published" -ForegroundColor Green
Write-Host "Release : $releasesRoot"
Write-Host "Setup   : $(Join-Path $releasesRoot 'Deckino.Toolbox-win-Setup.exe')"
if ($SkipUpload) {
    Write-Host "Not uploaded (-SkipUpload)." -ForegroundColor Yellow
}
else {
    Write-Host "Uploaded to the bucket's toolbox/ prefix; installed Toolboxes offer it on their sidebar."
}
