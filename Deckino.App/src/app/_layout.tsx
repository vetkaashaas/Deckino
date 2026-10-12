import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { installRemoteLog } from '@/diagnostics/remote-log';
import { colors } from '@/theme';

installRemoteLog();

// A share that cold-starts the app opens /shared-scan; keep the tabs beneath it to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' };

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="shared-scan" options={{ title: 'Shared photo' }} />
      </Stack>
    </>
  );
}
