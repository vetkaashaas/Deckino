# Deckino.App

Expo app (Android first) for continuous Magic: The Gathering card recognition.
See `../PLAN.md` for the overall design.

## Stack

- Expo SDK 57, TypeScript, expo-router, dev-client builds (no Expo Go)
- `react-native-vision-camera` v5 (Nitro) — camera preview + frame output
- Recognition runs behind the `ICardRecognizer` seam (`src/recognition/`);
  phase 1 ships a mock recognizer + temporal voter so the scan UX is testable
  before the TFLite model exists

## Develop

```bash
npm install
npx expo run:android   # builds a dev client and installs on a device/emulator
npm start              # then press 'a' or connect to an existing dev build
```

A native build is required whenever native modules change; JS edits hot-reload.

## Verify

```bash
npm run typecheck
```
