import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useSignedIn } from '@/api/session';
import { usePreferences } from '@/preferences';
import { colors } from '@/theme';

export default function TabsLayout() {
  const router = useRouter();
  // Signed out and no "Not now" yet (first launch, or after signing out): the welcome screen. Not over a shared
  // photo that cold-started the app; it comes once that is closed.
  const signedIn = useSignedIn();
  const { welcomeSeen } = usePreferences();
  const welcome = !signedIn && !welcomeSeen;
  const sharing = useSegments()[0] === 'shared-scan';
  useEffect(() => {
    if (welcome && !sharing) router.push('/welcome');
  }, [welcome, sharing, router]);

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.purple}
      rippleColor="rgba(152, 29, 206, 0.24)"
      tintColor={colors.pink}
      iconColor={{ default: colors.textDim, selected: colors.text }}
      labelStyle={{
        default: { color: colors.textDim, fontSize: 12 },
        selected: { color: colors.text, fontSize: 12, fontWeight: '600' },
      }}
      labelVisibilityMode="labeled"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="cards">
        <NativeTabs.Trigger.Icon sf="rectangle.stack" md="playing_cards" />
        <NativeTabs.Trigger.Label>Cards</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="scan">
        <NativeTabs.Trigger.Icon sf="viewfinder" md="document_scanner" />
        <NativeTabs.Trigger.Label>Scan</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="collection">
        <NativeTabs.Trigger.Icon sf="books.vertical" md="collections_bookmark" />
        <NativeTabs.Trigger.Label>Collection</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="decks">
        <NativeTabs.Trigger.Icon sf="square.stack.3d.up" md="stacks" />
        <NativeTabs.Trigger.Label>Decks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
