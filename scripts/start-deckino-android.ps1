# USB Expo start. The phone cannot reach this PC over Wi-Fi, so the QR
# code will whitescreen. adb reverse makes http://127.0.0.1:8081 on the
# phone hit Metro here.
param(
    [string]$Serial = "RZCY326LL3P"
)

$ErrorActionPreference = "Stop"
$androidHome = $env:ANDROID_HOME
if (-not $androidHome) {
    $androidHome = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
$adb = Join-Path $androidHome "platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
    throw "adb not found at $adb"
}

function Wait-MetroIPv4 {
    param([int]$Seconds = 90)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:8081/status" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                return
            }
        } catch {
            Start-Sleep -Seconds 1
        }
        Start-Sleep -Milliseconds 400
    }
    throw "Metro did not answer on http://127.0.0.1:8081. Is another process using that port?"
}

function Open-Deckino {
    param([string]$AdbPath, [string]$Serial)
    & $AdbPath -s $Serial reverse tcp:8081 tcp:8081 | Out-Null
    & $AdbPath -s $Serial reverse tcp:8082 tcp:8082 | Out-Null
    $cmd = "am start -n com.deckino.app/.MainActivity -a android.intent.action.VIEW -d 'exp+deckino://expo-development-client/?url=http://127.0.0.1:8081'"
    & $AdbPath -s $Serial shell $cmd
}

& $adb start-server | Out-Null
$state = ((& $adb -s $Serial get-state 2>&1) | Out-String).Trim()
if ($state -ne "device") {
    Write-Host "Attached devices:"
    & $adb devices -l
    throw "Phone $Serial is not ready (adb state: '$state'). Plug it in and allow USB debugging."
}

Open-Deckino -AdbPath $adb -Serial $Serial
Write-Host "adb reverse:"
& $adb -s $Serial reverse --list

Set-Location (Join-Path $PSScriptRoot "..\Deckino.App")
$npx = Join-Path $env:APPDATA "npm\npx.cmd"
if (-not (Test-Path $npx)) {
    $npx = "npx"
}

Write-Host ""
Write-Host "Starting Metro on port 8081 (IPv4). Leave this window open."
Write-Host "Do not scan the QR code."
Write-Host ""

$metro = Start-Process -FilePath $npx -ArgumentList @("expo","start","--port","8081","--host","lan") -WorkingDirectory (Get-Location) -PassThru -NoNewWindow
try {
    Wait-MetroIPv4
    Write-Host "Metro is up on http://127.0.0.1:8081 - opening Deckino on the phone."
    Open-Deckino -AdbPath $adb -Serial $Serial
    Wait-Process -Id $metro.Id
} finally {
    if ($metro -and -not $metro.HasExited) {
        Stop-Process -Id $metro.Id -Force -ErrorAction SilentlyContinue
    }
}
