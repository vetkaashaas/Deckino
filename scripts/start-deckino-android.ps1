# USB Expo start. The phone cannot reach this PC over Wi-Fi, so scanning
# the LAN QR whitescreens. adb reverse makes 127.0.0.1:8081 on the phone
# reach Metro here.
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

& $adb start-server | Out-Null
$devices = & $adb devices
if ($devices -notmatch $Serial) {
    Write-Host "Attached devices:"
    Write-Host $devices
    throw "Phone $Serial is not attached. Plug it in and allow USB debugging."
}

& $adb -s $Serial reverse tcp:8081 tcp:8081 | Out-Null
& $adb -s $Serial reverse tcp:8082 tcp:8082 | Out-Null
Write-Host "adb reverse:"
& $adb -s $Serial reverse --list

Set-Location (Join-Path $PSScriptRoot "..\Deckino.App")
Write-Host ""
Write-Host "Starting Metro at http://127.0.0.1:8081"
Write-Host "Open Deckino from the app drawer. Do not scan the QR code."
Write-Host "If the screen is white, run this in another terminal:"
Write-Host "  `"$adb`" -s $Serial shell am start -a android.intent.action.VIEW -d `"exp+deckino://expo-development-client/?url=http://127.0.0.1:8081`""
Write-Host ""
npx expo start --localhost --port 8081
