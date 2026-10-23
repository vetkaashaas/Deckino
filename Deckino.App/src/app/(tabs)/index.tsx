import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useAccount } from '@/api/account';
import { useBinders, useCollectionPrices, useMarketMovers } from '@/api/binders';
import { useSignedIn } from '@/api/session';
import { CollectionValue } from '@/components/collection-summary';
import { Icon } from '@/components/icon';
import { MoverRow } from '@/components/price-mover';
import { Avatar, Button, Chip, Screen, usePullToRefresh } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, gradients, radius, type } from '@/theme';

// Home (AppPlan, Phase A9). Signed in: what's new for you, value first; what you have is on Collection and Decks.
// Signed out: what Deckino is, scanning (which needs no account), and signing in to keep cards.
export default function HomeScreen() {
  return useSignedIn() ? <Dashboard /> : <Welcome />;
}

function Dashboard() {
  const router = useRouter();
  const { currency } = usePreferences();
  const username = useAccount().data?.username;
  const binders = useBinders(currency);
  const prices = useCollectionPrices(currency);
  const market = useMarketMovers(currency);
  const [falling, setFalling] = useState(false);
  const refreshControl = usePullToRefresh(() => Promise.all([binders.refetch(), prices.refetch(), market.refetch()]));
  const movers = (falling ? market.data?.falling : market.data?.rising) ?? [];
  // No cards yet (or no binders): nothing to value, so the value's place invites the first scan.
  const noCards = binders.data?.every((binder) => binder.cardCount === 0);

  return (
    <Screen title={username ? `Hi, ${username}` : 'Home'}>
      {/* Fades out under the title rather than cutting off (Android only; iOS ignores it). React Native fades the edge
          even at the top of the scroll, so the content starts below the fade (styles.dashboard). */}
      <ScrollView contentContainerStyle={styles.dashboard} refreshControl={refreshControl} fadingEdgeLength={{ start: FADE, end: 0 }}>
        <CollectionValue empty={noCards} onPress={() => router.navigate(noCards ? '/scan' : '/collection')} />

        {market.data && market.data.rising.length + market.data.falling.length > 0 ? (
          <Section title="Market movers this week">
            <View style={styles.chips}>
              <Chip label="Rising" selected={!falling} onPress={() => setFalling(false)} />
              <Chip label="Falling" selected={falling} onPress={() => setFalling(true)} />
            </View>
            {movers.map((mover) => (
              <MoverRow key={mover.card.id} mover={mover} currency={currency} market />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={type.heading} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Welcome() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <View style={styles.glow} pointerEvents="none" />
      <SafeAreaView style={styles.safe} edges={['top']}>
        {/* Spread over a tall phone, scrolling on a short one so the buttons are never hidden. */}
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.topBar}>
            <Avatar />
          </View>
          <View style={styles.hero}>
            <Image
              source={require('../../../assets/images/brand/logo-original.svg')}
              style={styles.logo}
              contentFit="contain"
              accessibilityLabel="Deckino"
            />
            <Text style={styles.tagline}>{"Point your camera at a Magic card to see what it is and what it's worth."}</Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
              onPress={() => router.navigate('/scan')}
            >
              <Icon name="document_scanner" size={22} tintColor={colors.text} />
              <Text style={styles.ctaLabel}>Start scanning</Text>
            </Pressable>
            <Button label="Sign in to keep your cards" variant="secondary" onPress={() => router.push('/sign-in')} />
            <Text style={[type.label, styles.center]}>No account needed to scan.</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const FADE = 16;

const styles = StyleSheet.create({
  dashboard: { paddingHorizontal: 20, paddingTop: FADE, paddingBottom: 24, gap: 20 },
  section: { gap: 10 },
  chips: { flexDirection: 'row', gap: 8 },

  container: { flex: 1, backgroundColor: colors.background },
  glow: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: `radial-gradient(circle at 50% 38%, rgba(121, 17, 203, 0.35) 0%, rgba(176, 89, 255, 0.10) 40%, rgba(11, 6, 16, 0) 70%)`,
  },
  safe: { flex: 1 },
  content: { flexGrow: 1, gap: 24, paddingHorizontal: 24, paddingBottom: 24 },
  topBar: { alignItems: 'flex-end', paddingTop: 8 },
  // Takes the free space so the logo sits in the middle and the buttons at the bottom, in thumb reach.
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: { width: 320, height: 320 * (396.58 / 1200) },
  tagline: { color: colors.textMuted, fontSize: 17, lineHeight: 25, textAlign: 'center', maxWidth: 300 },
  actions: { gap: 12 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 56,
    borderRadius: radius.pill,
    experimental_backgroundImage: gradients.brand,
    boxShadow: '0 8px 24px rgba(121, 17, 203, 0.45)',
  },
  ctaPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  ctaLabel: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  center: { textAlign: 'center' },
});
