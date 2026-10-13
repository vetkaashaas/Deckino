import { Linking, StyleSheet, Text, View } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useUpdateRequired } from '@/api/app-config';
import { queryClient } from '@/api/query-client';
import { Button } from '@/components/ui';
import { installRemoteLog } from '@/diagnostics/remote-log';
import { ambient, colors, fonts, type } from '@/theme';

installRemoteLog();

// A share that cold-starts the app opens /shared-scan; keep the tabs beneath it to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' };

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" />
      <App />
    </QueryClientProvider>
  );
}

// The update screen covers the app rather than replacing it: expo-router needs its navigator mounted to take in
// shared photos and links.
function App() {
  const updateRequired = useUpdateRequired();
  return (
    <>
      {/* Hidden from screen readers while covered. */}
      <View style={styles.app} importantForAccessibility={updateRequired ? 'no-hide-descendants' : 'auto'}>
        <AppStack />
      </View>
      {updateRequired ? <UpdateRequired /> : null}
    </>
  );
}

function AppStack() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.heading, fontWeight: '700' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="shared-scan" options={{ title: 'Shared photo' }} />
      <Stack.Screen name="card/[id]" options={{ title: '' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="sign-in" options={{ title: '', presentation: 'modal' }} />
      <Stack.Screen name="register" options={{ title: '', presentation: 'modal' }} />
      <Stack.Screen name="forgot-password" options={{ title: 'Forgot password' }} />
      <Stack.Screen name="account/username" options={{ title: 'Username' }} />
      <Stack.Screen name="account/password" options={{ title: 'Change password' }} />
      <Stack.Screen name="account/delete" options={{ title: 'Delete account' }} />
      <Stack.Screen name="preference/[key]" options={{ title: '' }} />
      <Stack.Screen
        name="help-improve"
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}
      />
      <Stack.Screen name="styleguide" options={{ title: 'Style guide' }} />
    </Stack>
  );
}

// The API no longer supports this build: one way forward, nothing that could fail in odd ways.
function UpdateRequired() {
  return (
    <View style={styles.update}>
      <View style={styles.glow} pointerEvents="none" />
      <Image
        source={require('../../assets/images/brand/logo-original.svg')}
        style={styles.logo}
        contentFit="contain"
        accessibilityLabel="Deckino"
      />
      <Text style={[type.title, styles.center]} accessibilityRole="header">
        Update Deckino
      </Text>
      <Text style={[type.body, styles.center, { color: colors.textMuted }]}>
        This version of Deckino is no longer supported. Update it from Google Play to keep going.
      </Text>
      <Button
        label="Open Google Play"
        onPress={() => Linking.openURL('market://details?id=com.deckino.app')}
        style={styles.action}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  update: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: { width: 240, height: 240 * (396.58 / 1200) },
  center: { textAlign: 'center' },
  action: { alignSelf: 'stretch', marginTop: 8 },
});
