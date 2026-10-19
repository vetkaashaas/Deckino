import { Linking, StyleSheet, Text, View } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useUpdateRequired } from '@/api/app-config';
import { queryClient } from '@/api/query-client';
import { ToastHost } from '@/components/toast';
import { Button } from '@/components/ui';
import { installRemoteLog } from '@/diagnostics/remote-log';
import { useModelUpdates } from '@/scan/model-store';
import { ambient, colors, fonts, type } from '@/theme';

installRemoteLog();

// A share that cold-starts the app opens /shared-scan; keep the tabs beneath it to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' };

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.app}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <App />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

// The update screen covers the app rather than replacing it: expo-router needs its navigator mounted to take in
// shared photos and links.
function App() {
  const updateRequired = useUpdateRequired();
  useModelUpdates();
  return (
    <>
      {/* Hidden from screen readers while covered. */}
      <View style={styles.app} importantForAccessibility={updateRequired ? 'no-hide-descendants' : 'auto'}>
        <AppStack />
        <ToastHost />
      </View>
      {updateRequired ? <UpdateRequired /> : null}
    </>
  );
}

const seeThrough = { title: '', headerTransparent: true, headerStyle: { backgroundColor: 'transparent' } };

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
      <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
      {/* The signed-out screens: a see-through header over FormScreen's brand glow. */}
      <Stack.Screen name="sign-in" options={{ ...seeThrough, presentation: 'modal' }} />
      <Stack.Screen name="register" options={{ ...seeThrough, presentation: 'modal' }} />
      <Stack.Screen name="forgot-password" options={seeThrough} />
      <Stack.Screen name="verify-email" options={seeThrough} />
      <Stack.Screen name="reset-password" options={seeThrough} />
      <Stack.Screen name="account/username" options={{ title: 'Username' }} />
      <Stack.Screen name="account/password" options={{ title: 'Change password' }} />
      <Stack.Screen name="account/delete" options={{ title: 'Delete account' }} />
      <Stack.Screen name="preference/[key]" options={{ title: '' }} />
      <Stack.Screen name="defaults" options={{ title: 'New cards' }} />
      <Stack.Screen name="binder/new" options={{ title: 'New binder', presentation: 'modal' }} />
      <Stack.Screen name="binder/[id]/index" options={{ title: '' }} />
      <Stack.Screen name="binder/[id]/card" options={{ title: '', presentation: 'modal' }} />
      <Stack.Screen name="binder/[id]/move" options={{ title: 'Move cards' }} />
      <Stack.Screen name="binder/[id]/add" options={{ title: 'Add by name' }} />
      <Stack.Screen name="binder/[id]/settings" options={{ title: 'Binder settings' }} />
      <Stack.Screen name="deck/new" options={{ title: 'New deck', presentation: 'modal' }} />
      <Stack.Screen name="deck/[id]/index" options={{ title: '' }} />
      <Stack.Screen name="deck/[id]/card" options={{ title: '', presentation: 'modal' }} />
      <Stack.Screen name="deck/[id]/add" options={{ title: 'Add by name' }} />
      <Stack.Screen name="deck/[id]/settings" options={{ title: 'Deck settings' }} />
      <Stack.Screen name="public/deck/[id]" options={{ title: '' }} />
      <Stack.Screen name="public/binder/[id]" options={{ title: '' }} />
      <Stack.Screen name="import" options={{ title: 'Import a deck' }} />
      <Stack.Screen name="wishlist/index" options={{ title: 'Wishlist' }} />
      <Stack.Screen name="wishlist/card" options={{ title: '', presentation: 'modal' }} />
      <Stack.Screen name="wishlist/add" options={{ title: 'Add by name' }} />
      <Stack.Screen name="e2e-scan" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="tray" options={{ title: 'Scanned cards', presentation: 'modal' }} />
      <Stack.Screen name="tray-card" options={{ title: '', presentation: 'modal' }} />
      <Stack.Screen name="tray-binder" options={{ title: 'Choose where', presentation: 'modal' }} />
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
