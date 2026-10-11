// Photos shared into the app arrive as an expo-sharing deep link; scan them on their own page.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return new URL(path).hostname === 'expo-sharing' ? '/shared-scan' : path;
  } catch {
    return path;
  }
}
