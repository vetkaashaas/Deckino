# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Project notes

- SDK 57 / RN 0.86 / React 19.2, strict TS. Routes live in `src/app`.
- vision-camera is **v5** (Nitro-based): use `useFrameOutput({ onFrame })` +
  `<Camera outputs={[...]} />`, dispose every `Frame`, and talk back to React
  via `runOnJS` from `react-native-worklets`. The v4 API
  (`useFrameProcessor`, `useCameraDevice` as hook requirement) is gone.
- Frame-processor callbacks run on a separate worklet runtime: any function
  they call must itself carry the `'worklet'` directive (otherwise it becomes
  a Remote Function and sync-calling it throws). Instantiate recognizer/voter
  lazily inside the callback runtime (globalThis singleton) and talk back to
  React only via `runOnJS` from `react-native-worklets`.
- `npm run typecheck` must pass before handing off.

# Running the app on Android

Scripts live in `../scripts`. A phone on USB and an emulator are often attached together, so always name the
device: `adb -s <serial>` / `adb -e` (the only emulator), `maestro --device <serial>`, `ANDROID_SERIAL` for Gradle.

## The phone (serial RZCY326LL3P)

- Dev client + Metro: `scripts/deckino-android-dev.ps1` (adb reverse, Metro on 8081, hot reload). The app talks
  to `EXPO_PUBLIC_API_URL`, else https://deckino.com, so API changes must be deployed before the phone sees them.
- The dev client is a native build: after adding or upgrading a native dependency or an app.json plugin, rebuild it,
  or the app fails with `Cannot find native module '…'` whatever Metro serves:
  `$env:ANDROID_SERIAL="RZCY326LL3P"; cd android; .\gradlew app:installDebug -PreactNativeArchitectures=arm64-v8a`
  (`npx expo prebuild --platform android` first when app.json plugins changed). Swipe the old app away before
  reopening it, or Metro's intent reaches the old process.
- Standalone preview build, no Metro: `scripts/deckino-android-deploy.ps1` ("Deckino Preview", arm64).

## The emulator

- AVDs: `deckino_e2e` (a Pixel 9 Pro, API 36, 4 GB, for Deckino's tests; the E2E default) and the shared
  `pixel_9_pro_-_api_36` and `nexus_4_-_api_36`. x86_64 images on WHPX. Never set a screen lock on `deckino_e2e`:
  after a cold boot a locked emulator keeps its storage locked, and Maestro's driver fails to start ("not
  encryption aware" in logcat) while Maestro waits forever. `pixel_9_pro_-_api_36` has a lock.
- **Always start it on port 5680.** Hyper-V reserves the emulator's default ports (5554–5585) on this PC, and the
  emulator then aborts with "too many emulator instances are running" (see
  `netsh int ipv4 show excludedportrange protocol=tcp`). Its serial is then `emulator-5680`:

      & "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd deckino_e2e -port 5680 -memory 4096 -no-snapshot-save

  It boots in under a minute; `adb -s emulator-5680 shell getprop sys.boot_completed` prints 1 when ready.
- Phone builds (arm64) don't install on it (`INSTALL_FAILED_NO_MATCHING_ABIS`). What does:
  - The E2E APK, `scripts/build-android-release.ps1 -E2E`: x86_64, talks to the E2E API at `http://10.0.2.2:5890`
    (the emulator's name for this PC), style guide in Profile. Never put it on a real phone.
  - A dev client: `$env:ANDROID_SERIAL="emulator-5680"; cd android; .\gradlew app:installDebug -PreactNativeArchitectures=x86_64`,
    then `adb -s emulator-5680 reverse tcp:8081 tcp:8081` and Metro as for the phone. To use the local dev API
    instead of production, start Metro with `$env:EXPO_PUBLIC_API_URL="http://10.0.2.2:5880"` (debug builds allow
    plain HTTP).

## Checking how it looks

- The E2E run does it all: `scripts/app-e2e.ps1 [-Build]` starts the E2E API (5890, E2E database, Scryfall
  fixture), the emulator, installs the newest E2E APK and runs every flow in `.maestro`. Milestone screenshots and
  JUnit reports land in `e2e-results/maestro`, the screenshots in its `screenshots` folder (Maestro's own logs and
  failure screenshots in `debug/`). `-Build` is
  needed after any app change.
- One flow while the E2E API runs: `maestro --device emulator-5680 test .maestro/cards.yaml`. Flows find elements
  by visible text or accessibility label, so give new controls a label.
- A screenshot at any moment: `adb -s emulator-5680 exec-out screencap -p > shot.png`.
- A small phone: `adb -e shell wm size 720x1280` and `adb -e shell wm density 320`; undo with `wm size reset` and
  `wm density reset`.
- The style guide (Profile → Style guide, dev and E2E builds) shows every component in its states; check new
  components there at both sizes.
- Scanning can't be automated here: the camera needs a real card, and a photo shared from adb arrives unreadable
  (Android copies a share into the app's cache only for a sender that may grant it). Test scans on the phone.

## Setting the emulator up from scratch (what worked, 2026-10-13)

1. Maestro 2.x in `~/.maestro/maestro/bin` (`maestro.bat`; the script finds it there) and Java 17.
2. The `deckino_e2e` AVD. Android Studio's cmdline-tools (avdmanager) aren't installed, so it is a copy of the
   Pixel 9 Pro's config with fresh data (Git Bash):

       AVD=~/.android/avd; mkdir -p $AVD/deckino_e2e.avd
       sed -e 's/^AvdId=.*/AvdId=deckino_e2e/' -e 's/^avd.ini.displayname=.*/avd.ini.displayname=Deckino E2E (Pixel 9 Pro, API 36)/' \
           -e 's/^hw.ramSize=.*/hw.ramSize=4096/' $AVD/pixel_9_pro_-_api_36.avd/config.ini > $AVD/deckino_e2e.avd/config.ini
       sed -e 's#pixel_9_pro_-_api_36#deckino_e2e#g' $AVD/pixel_9_pro_-_api_36.ini > $AVD/deckino_e2e.ini

   It needs the `system-images\android-36\google_apis_playstore\x86_64` image (SDK Manager).
3. First boot on port 5680 (about 50 s; it creates its data). Check it is unlocked:
   `adb -s emulator-5680 shell dumpsys user` must show `State: RUNNING_UNLOCKED`.
4. `scripts/app-e2e.ps1 -Build`. It reuses a running emulator, else starts `deckino_e2e` minimized on port 5680.
   Headless (`-no-window` instead of a minimized window) also kept the emulator up for a whole run, but the passing
   runs used the window.

## When an emulator run fails

Look in `e2e-results/maestro/debug/<time>/<flow>/`: `commands.json` has each step's status and error, `screenshots/`
the screen at the failure, `logs/` Maestro's log and the device logcat. No folder there means the flow never
started: see `~/.maestro/tests/<time>/maestro.log`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Emulator exits with "too many emulator instances are running" | Hyper-V reserved its default ports | `-port 5680` |
| Maestro stops after "Selected device"; screen black; logcat "not encryption aware" | The AVD has a screen lock, storage stays locked after a cold boot | Use `deckino_e2e` (no lock) |
| Maestro fails at once, no debug folder | YAML error, e.g. `"\d"` in a double-quoted string | `maestro check-syntax .maestro/<flow>.yaml` |
| Everything looks small; Home's button not found | A run died at the small size and `wm size` survives restarts | `adb -e shell wm size reset`, `wm density reset` (the script does this first) |
| "No visible element found" for text that is on screen | An ancestor with the same `accessibilityLabel` is matched and isn't fully on screen | Don't repeat visible text as a container's label |
| "device offline", the emulator gone mid-run | Twice, cause unknown (no crash report, RAM free) | Run again |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | An arm64 build, or adb aimed at the phone | x86_64 E2E APK; `adb -e`/`-s emulator-5680` |
| A Git Bash adb command can't find `/sdcard/...` | Git Bash rewrites Unix paths | `export MSYS_NO_PATHCONV=1` |
| A PowerShell loop over `adb ... 2>$null` throws | Windows PowerShell turns a native command's stderr into an error under `Stop` | Wrap it in `try { } catch { }` |
