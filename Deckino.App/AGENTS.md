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
