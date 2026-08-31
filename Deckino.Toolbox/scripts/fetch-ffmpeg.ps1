[CmdletBinding()]
param(
    [string]$DestinationRoot
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
    $DestinationRoot = Join-Path $projectRoot "third_party\ffmpeg\win-x64"
}

$archiveUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-29-13-12/ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0.zip"
$archiveSha256 = "e452726c9282e9d8b640dd29f012db91bf6133b490b5490a37e8b0a4d3ec7ae9"
$runtimeManifestPath = Join-Path $DestinationRoot "runtime.json"

if ((Test-Path -LiteralPath (Join-Path $DestinationRoot "ffmpeg.exe") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $DestinationRoot "ffprobe.exe") -PathType Leaf) -and
    (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf)) {
    $installed = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    if ($installed.archiveSha256 -eq $archiveSha256) {
        Write-Host "Pinned FFmpeg runtime is already available at $DestinationRoot"
        return
    }
}

$resolvedProjectRoot = [IO.Path]::GetFullPath($projectRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedDestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)
if (-not $resolvedDestinationRoot.StartsWith(
        $resolvedProjectRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "FFmpeg destination must remain inside the Deckino.Toolbox project: $resolvedDestinationRoot"
}

$downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ("deckino-ffmpeg-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $downloadRoot "ffmpeg.zip"
$extractionRoot = Join-Path $downloadRoot "extracted"
try {
    New-Item -ItemType Directory -Path $downloadRoot | Out-Null
    Write-Host "Downloading pinned FFmpeg 9.0.1 LGPL runtime..."
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $archiveSha256) {
        throw "FFmpeg archive checksum mismatch. Expected $archiveSha256 but received $actualHash."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractionRoot
    $packageRoot = Get-ChildItem -LiteralPath $extractionRoot -Directory | Select-Object -First 1
    if ($null -eq $packageRoot) {
        throw "FFmpeg archive did not contain a package directory."
    }

    $requiredFiles = @(
        "ffmpeg.exe",
        "ffprobe.exe",
        "avcodec-63.dll",
        "avdevice-63.dll",
        "avfilter-12.dll",
        "avformat-63.dll",
        "avutil-61.dll",
        "swresample-7.dll",
        "swscale-10.dll"
    )
    $packageBin = Join-Path $packageRoot.FullName "bin"
    $missingFiles = $requiredFiles | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $packageBin $_) -PathType Leaf)
    }
    if ($missingFiles) {
        throw "FFmpeg archive is missing required runtime files: $($missingFiles -join ', ')"
    }

    if (Test-Path -LiteralPath $resolvedDestinationRoot) {
        Remove-Item -LiteralPath $resolvedDestinationRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $resolvedDestinationRoot | Out-Null
    foreach ($file in $requiredFiles) {
        Copy-Item -LiteralPath (Join-Path $packageBin $file) -Destination $resolvedDestinationRoot
    }
    Copy-Item -LiteralPath (Join-Path $packageRoot.FullName "LICENSE.txt") -Destination $resolvedDestinationRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot "third_party\ffmpeg\README.md") -Destination $resolvedDestinationRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot "third_party\ffmpeg\THIRD-PARTY-NOTICES.txt") -Destination $resolvedDestinationRoot

    [ordered]@{
        ffmpegVersion = "9.0.1"
        ffmpegCommit = "e47273f4d9"
        buildRelease = "autobuild-2026-08-29-13-12"
        variant = "win64-lgpl-shared-9.0"
        archiveUrl = $archiveUrl
        archiveSha256 = $archiveSha256
    } | ConvertTo-Json | Set-Content -LiteralPath $runtimeManifestPath -Encoding utf8
    Write-Host "FFmpeg runtime ready at $resolvedDestinationRoot"
}
finally {
    if (Test-Path -LiteralPath $downloadRoot) {
        Remove-Item -LiteralPath $downloadRoot -Recurse -Force
    }
}
