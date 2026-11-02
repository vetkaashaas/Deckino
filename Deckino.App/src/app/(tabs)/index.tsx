import { useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useAccount } from '@/api/account';
import { useBinders, useCollectionPrices, useMarketMovers } from '@/api/binders';
import { usePublicDecks } from '@/api/decks';
import { queryClient } from '@/api/query-client';
import { useSignedIn } from '@/api/session';
import { CollectionValue } from '@/components/collection-summary';
import { DeckTile } from '@/components/deck-tile';
import { Icon } from '@/components/icon';
import { Pager, usePager } from '@/components/pager';
import { MoverRow } from '@/components/price-mover';
import { Avatar, Button, Screen, usePullToRefresh } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, gradients, radius, type } from '@/theme';

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
  const refresh = () =>
    Promise.all([binders.refetch(), prices.refetch(), queryClient.refetchQueries({ queryKey: ['market-movers'] })]);
  const refreshControl = usePullToRefresh(refresh);
  // No cards yet (or no binders): nothing to value, so the first scan takes the value's place, with other players'
  // decks next to show what Deckino is for.
  const noCards = binders.data?.every((binder) => binder.cardCount === 0);

  if (noCards) {
    // The first scan and the decks take the room, so the top three movers, and the page scrolls.
    return (
      <Screen title={username ? `Hi, ${username}` : 'Home'}>
        {/* Fades out under the title rather than cutting off (Android only; iOS ignores it). React Native fades the edge
            even at the top of the scroll, so the content starts below the fade (styles.scroll). */}
        <ScrollView contentContainerStyle={styles.scroll} refreshControl={refreshControl} fadingEdgeLength={{ start: FADE, end: 0 }}>
          <FirstScan />
          <OthersDecks username={username} />
          <Movers top={3} refresh={refresh} />
        </ScrollView>
      </Screen>
    );
  }

  // The value stays put; the movers below it fill the rest of the screen and scroll on their own, a page at a time.
  return (
    <Screen title={username ? `Hi, ${username}` : 'Home'}>
      <View style={styles.dashboard}>
        <CollectionValue onPress={() => router.navigate('/collection')} line />
        <Movers refresh={refresh} />
      </View>
    </Screen>
  );
}

// Rising and Falling side by side: a sideways drag moves the lists with the finger and snaps to one, and the header's
// labels light up as it goes. Falling loads once it's first shown. With `top`, only that many of each, and no scrolling.
function Movers({ top, refresh }: { top?: number; refresh: () => Promise<unknown> }) {
  const { currency } = usePreferences();
  const { width } = useWindowDimensions();
  const rising = useMarketMovers(currency, false);
  const position = usePager(0);
  const [falling, setFalling] = useState(false);
  const [shown, setShown] = useState(false); // Falling has been on screen
  // Nothing moved (no price history from a week ago yet): no section.
  if (rising.isSuccess && rising.data.pages[0].movers.length === 0) return null;

  const show = (down: boolean) => {
    setFalling(down);
    setShown(shown || down);
  };
  return (
    <View style={[styles.section, !top && styles.flex]}>
      <View style={styles.sectionHeader}>
        <Text style={type.heading} accessibilityRole="header">
          Movers this week
        </Text>
        <View style={styles.toggle} accessibilityRole="tablist">
          {[false, true].map((down) => (
            <MoverTab key={String(down)} down={down} selected={falling === down} x={position.x} width={width} onPress={() => show(down)} />
          ))}
        </View>
      </View>
      <Pager
        page={falling ? 1 : 0}
        onPage={(at) => setFalling(at === 1)}
        position={position}
        onDragStart={() => setShown(true)} // starts loading Falling as the drag starts
        style={styles.bleed}
      >
        <MoverPage falling={false} top={top} refresh={refresh} />
        {shown ? <MoverPage falling top={top} refresh={refresh} /> : null}
      </Pager>
    </View>
  );
}

// Lavender while its page is on screen, fading to grey as the other one slides in.
function MoverTab({
  down,
  selected,
  x,
  width,
  onPress,
}: {
  down: boolean;
  selected: boolean;
  x: SharedValue<number>;
  width: number;
  onPress: () => void;
}) {
  const at = down ? 1 : 0;
  const color = useAnimatedStyle(() => ({
    color: interpolateColor(x.value / width, [at - 1, at, at + 1], [colors.textDim, colors.lavender, colors.textDim]),
  }));
  return (
    <Pressable onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected }} hitSlop={8}>
      <Animated.Text style={[styles.toggleLabel, color]}>{down ? 'Falling' : 'Rising'}</Animated.Text>
    </Pressable>
  );
}

function MoverPage({ falling, top, refresh }: { falling: boolean; top?: number; refresh: () => Promise<unknown> }) {
  const { currency } = usePreferences();
  const market = useMarketMovers(currency, falling);
  const refreshControl = usePullToRefresh(refresh);
  const movers = market.data?.pages.flatMap((page) => page.movers) ?? [];
  if (top) {
    return (
      <View style={styles.page}>
        {movers.slice(0, top).map((mover) => (
          <MoverRow key={mover.card.id} mover={mover} currency={currency} market />
        ))}
      </View>
    );
  }
  return (
    <FlatList
      data={movers}
      keyExtractor={(mover) => mover.card.id}
      renderItem={({ item }) => <MoverRow mover={item} currency={currency} market />}
      refreshControl={refreshControl}
      accessibilityLabel={falling ? 'Falling cards' : 'Rising cards'}
      contentContainerStyle={[styles.page, styles.movers]}
      // Fades out at the bottom rather than cutting a row off (Android only).
      fadingEdgeLength={{ start: 0, end: FADE }}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (market.hasNextPage && !market.isFetchingNextPage) void market.fetchNextPage();
      }}
      ListEmptyComponent={market.isPending ? <ActivityIndicator color={colors.lavender} style={styles.more} /> : null}
      ListFooterComponent={
        market.isFetchingNextPage ? (
          <ActivityIndicator color={colors.lavender} style={styles.more} />
        ) : market.isFetchNextPageError ? (
          <Button label="Couldn't load more. Try again" variant="secondary" onPress={() => void market.fetchNextPage()} style={styles.more} />
        ) : null
      }
    />
  );
}

function FirstScan() {
  const router = useRouter();
  return (
    <View style={styles.firstScan}>
      <View style={styles.firstScanGlow} pointerEvents="none" />
      <View style={styles.scanIcon}>
        <Icon name="document_scanner" size={36} tintColor={colors.text} />
      </View>
      <Text style={styles.firstScanTitle}>Scan your first card</Text>
      <Text style={styles.firstScanBody}>
        {"Point your camera at any Magic card. You'll see what it is and what it's worth, and it goes straight into your collection."}
      </Text>
      <Button label="Start scanning" icon="photo_camera" onPress={() => router.navigate('/scan')} style={styles.stretch} />
    </View>
  );
}

const TILE = 140;

// The newest public decks that aren't yours, across the screen; "See all" opens them on Decks.
function OthersDecks({ username }: { username?: string }) {
  const router = useRouter();
  const search = usePublicDecks('', '');
  const decks = (search.data?.pages[0]?.decks ?? []).filter(({ owner }) => owner !== username);
  if (decks.length === 0) return null;
  return (
    <Section
      title="Decks from other players"
      action={
        <Pressable onPress={() => router.navigate('/decks?view=public')} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.link}>See all</Text>
        </Pressable>
      }
    >
      <FlatList
        horizontal
        data={decks}
        keyExtractor={({ deck }) => deck.id}
        showsHorizontalScrollIndicator={false}
        style={styles.bleed}
        contentContainerStyle={styles.tiles}
        renderItem={({ item: { deck, owner } }) => (
          <DeckTile deck={deck} width={TILE} byline={`by ${owner}`} brief href={{ pathname: '/public/deck/[id]', params: { id: deck.id } }} />
        )}
      />
    </Section>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={type.heading} accessibilityRole="header">
          {title}
        </Text>
        {action}
      </View>
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
  scroll: { paddingHorizontal: 20, paddingTop: FADE, paddingBottom: 16, gap: 16 },
  dashboard: { flex: 1, paddingHorizontal: 20, paddingTop: 16, gap: 16 },
  section: { gap: 4 },
  flex: { flex: 1 },
  page: { paddingHorizontal: 20 },
  movers: { paddingBottom: 16 },
  more: { marginVertical: 16 },
  sectionHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  link: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.violet },
  toggle: { flexDirection: 'row', gap: 16 },
  toggleLabel: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.textDim },
  // The row scrolls to the screen's edges, its first tile in line with the rest of the page.
  bleed: { marginHorizontal: -20 },
  tiles: { paddingHorizontal: 20, gap: 12 },

  firstScan: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 20,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(176, 89, 255, 0.35)',
    overflow: 'hidden',
  },
  firstScanGlow: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: `radial-gradient(circle at 50% 0%, rgba(121, 17, 203, 0.55) 0%, rgba(22, 13, 31, 0) 70%)`,
  },
  scanIcon: {
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    experimental_backgroundImage: gradients.brandDiagonal,
    boxShadow: '0 8px 28px rgba(176, 89, 255, 0.55)',
    marginBottom: 4,
  },
  firstScanTitle: { fontFamily: fonts.heading, fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'center' },
  firstScanBody: { ...type.body, color: colors.textMuted, textAlign: 'center', maxWidth: 300, marginBottom: 8 },
  stretch: { alignSelf: 'stretch' },

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
