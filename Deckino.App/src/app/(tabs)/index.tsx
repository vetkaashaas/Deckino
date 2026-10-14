import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { useAccount } from '@/api/account';
import { cardCount, useBinders, useCollectionPrices } from '@/api/binders';
import { useCommanderOfTheDay } from '@/api/cards';
import { changedAgo, formatLabel, useDecks } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { useWishlist } from '@/api/wishlist';
import { CardImage, formatPrice } from '@/components/card-visuals';
import { CollectionValue, WishlistRow } from '@/components/collection-summary';
import { MoverRow } from '@/components/price-mover';
import { Avatar, Button, ErrorState, ListRow, Screen, Skeleton, usePullToRefresh, type Icon } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, gradients, radius, type } from '@/theme';

// Home (AppPlan, Phase A9). Signed in: the website's dashboard on a phone, value first, Scan within thumb reach.
// Signed out: what Deckino is, scanning (which needs no account), and signing in to keep cards.
export default function HomeScreen() {
  return useSignedIn() ? <Dashboard /> : <Welcome />;
}

function Dashboard() {
  const router = useRouter();
  const { currency } = usePreferences();
  const username = useAccount().data?.username;
  const decks = useDecks();
  const binders = useBinders(currency);
  const prices = useCollectionPrices(currency);
  const wishlist = useWishlist();
  const commander = useCommanderOfTheDay();
  const queries = [decks, binders, prices, wishlist, commander];
  const refresh = () => Promise.all(queries.map((q) => q.refetch()));
  const refreshControl = usePullToRefresh(refresh);
  const movers = prices.data?.movers.slice(0, 3) ?? [];

  // Nothing loaded and nothing to show from before (offline at start): one way forward.
  if (decks.isError && !decks.data && binders.isError && !binders.data) {
    return (
      <Screen title="Home">
        <ErrorState message={binders.error.message} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen title={username ? `Welcome back, ${username}` : 'Welcome back'}>
      <ScrollView
        contentContainerStyle={styles.dashboard}
        refreshControl={refreshControl}
      >
        <CollectionValue onPress={() => router.navigate('/collection')} />

        <Section title="Recent decks" onSeeAll={decks.data?.length ? () => router.navigate('/decks?view=yours') : undefined}>
          {decks.data === undefined ? (
            decks.isError ? <Retry what="your decks" onRetry={() => void decks.refetch()} /> : <TileSkeletons />
          ) : decks.data.length === 0 ? (
            <ListRow
              leading={<SymbolView name={{ ios: 'plus', android: 'add' }} size={22} tintColor={colors.lavender} />}
              title="Make your first deck"
              detail="Build it here, by scanning or by name"
              onPress={() => router.push('/deck/new')}
            />
          ) : (
            <Tiles>
              {decks.data.slice(0, 6).map((deck) => (
                <Tile
                  key={deck.id}
                  image={deck.cover}
                  icon={{ ios: 'square.stack.3d.up', android: 'stacks' }}
                  title={deck.name}
                  detail={`${formatLabel(deck.format)} · ${changedAgo(deck.updatedAt)}`}
                  onPress={() => router.push(`/deck/${deck.id}`)}
                />
              ))}
            </Tiles>
          )}
        </Section>

        <Section title="Recent binders" onSeeAll={binders.data?.length ? () => router.navigate('/collection') : undefined}>
          {binders.data === undefined ? (
            binders.isError ? <Retry what="your binders" onRetry={() => void binders.refetch()} /> : <TileSkeletons />
          ) : binders.data.length === 0 ? (
            <ListRow
              leading={<SymbolView name={{ ios: 'plus', android: 'add' }} size={22} tintColor={colors.lavender} />}
              title="Make your first binder"
              detail="One for trades, one per box, whatever suits you"
              onPress={() => router.push('/binder/new')}
            />
          ) : (
            <Tiles>
              {binders.data.slice(0, 6).map((binder) => (
                <Tile
                  key={binder.id}
                  image={binder.cover}
                  icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
                  title={binder.name}
                  detail={binder.cardCount > 0 ? `${cardCount(binder.cardCount)} · ${formatPrice(binder.value, currency)}` : 'Empty'}
                  onPress={() => router.push(`/binder/${binder.id}`)}
                />
              ))}
            </Tiles>
          )}
        </Section>

        <WishlistRow />

        {commander.data ? (
          <Section title="Commander of the Day">
            <Pressable
              onPress={() => router.push(`/card/${commander.data.id}`)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.commander, pressed && styles.pressed]}
            >
              <View style={styles.commanderCard}>
                <CardImage uri={commander.data.images[0] ?? null} name={commander.data.name} />
              </View>
              <View style={styles.flex}>
                <Text style={type.heading}>{commander.data.name}</Text>
                {commander.data.typeLine ? <Text style={type.label}>{commander.data.typeLine}</Text> : null}
                {commander.data.artist ? <Text style={type.caption}>Art by {commander.data.artist}</Text> : null}
              </View>
            </Pressable>
          </Section>
        ) : null}

        {movers.length > 0 ? (
          <Section title="Biggest moves this week">
            {movers.map((mover) => (
              <MoverRow key={`${mover.card.id}-${mover.finish}`} mover={mover} currency={currency} />
            ))}
          </Section>
        ) : null}
      </ScrollView>
      <View style={styles.bar}>
        <Button label="Scan cards" icon={{ ios: 'viewfinder', android: 'document_scanner' }} onPress={() => router.navigate('/scan')} />
      </View>
    </Screen>
  );
}

function Section({ title, onSeeAll, children }: { title: string; onSeeAll?: () => void; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={type.heading} accessibilityRole="header">
          {title}
        </Text>
        {onSeeAll ? (
          <Pressable onPress={onSeeAll} accessibilityRole="button" accessibilityLabel={`See all: ${title}`} hitSlop={12}>
            <Text style={styles.link}>See all</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function Tiles({ children }: { children: ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tiles} style={styles.tilesScroll}>
      {children}
    </ScrollView>
  );
}

function Retry({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <ListRow
      leading={<SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh' }} size={22} tintColor={colors.danger} />}
      title={`Couldn't load ${what}`}
      detail="Tap to try again"
      onPress={onRetry}
    />
  );
}

function TileSkeletons() {
  return (
    <View style={styles.tiles}>
      <Skeleton style={styles.tileSkeleton} />
      <Skeleton style={styles.tileSkeleton} />
    </View>
  );
}

function Tile({
  image,
  icon,
  title,
  detail,
  onPress,
}: {
  image: string | null;
  icon: Icon;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
      <View style={styles.tileArt}>
        {image ? (
          <Image source={{ uri: image }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        ) : (
          <SymbolView name={icon} size={28} tintColor={colors.lavender} />
        )}
      </View>
      <Text style={[type.body, { fontWeight: '600' }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={type.label} numberOfLines={1}>
        {detail}
      </Text>
    </Pressable>
  );
}

const TIPS = [
  {
    icon: { ios: 'rectangle.portrait', android: 'style' },
    title: 'Fill the frame',
    detail: 'Line the card up inside the guide corners.',
  },
  {
    icon: { ios: 'sun.max', android: 'light_mode' },
    title: 'Good light, no glare',
    detail: 'Tilt the card slightly if the foil reflects.',
  },
  {
    icon: { ios: 'checkmark.seal', android: 'verified' },
    title: 'Hold steady',
    detail: 'The name locks in after a few agreeing frames.',
  },
] as const;

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
            <Text style={styles.tagline}>
              Point your camera at a Magic card to see what it is and what it's worth. No account needed.
            </Text>
          </View>

          <View style={styles.tips}>
            {TIPS.map((tip) => (
              <View key={tip.title} style={styles.tip}>
                <View style={styles.tipIcon}>
                  <SymbolView name={tip.icon} size={20} tintColor={colors.lavender} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.tipTitle}>{tip.title}</Text>
                  <Text style={styles.tipDetail}>{tip.detail}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
              onPress={() => router.navigate('/scan')}
            >
              <SymbolView name={{ ios: 'viewfinder', android: 'document_scanner' }} size={22} tintColor={colors.text} />
              <Text style={styles.ctaLabel}>Start scanning</Text>
            </Pressable>
            <Button label="Sign in to keep your cards" variant="secondary" onPress={() => router.push('/sign-in')} />
            <Text style={[type.label, styles.center]}>
              With an account, scanned cards go into binders and decks, and you see what your collection is worth.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  dashboard: { paddingHorizontal: 20, paddingBottom: 100, gap: 20 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  section: { gap: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  link: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: colors.lavender },
  tilesScroll: { marginHorizontal: -20 }, // to the screen's edges, so a half-shown tile says there are more
  tiles: { gap: 12, paddingHorizontal: 20 },
  tile: { width: 150, gap: 4 },
  tileArt: {
    height: 100,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
    marginBottom: 4,
  },
  tileSkeleton: { width: 150, height: 140, borderRadius: radius.md },
  commander: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 12,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  commanderCard: { width: 110 },
  flex: { flex: 1, gap: 4 },
  bar: { position: 'absolute', left: 20, right: 20, bottom: 12 },

  container: { flex: 1, backgroundColor: colors.background },
  glow: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: `radial-gradient(circle at 50% 18%, rgba(152, 29, 206, 0.35) 0%, rgba(222, 65, 144, 0.10) 40%, rgba(11, 6, 16, 0) 70%)`,
  },
  safe: { flex: 1 },
  content: { flexGrow: 1, gap: 24, paddingHorizontal: 24, paddingBottom: 24, justifyContent: 'space-between' },
  topBar: { alignItems: 'flex-end', paddingTop: 8 },
  hero: { alignItems: 'center', gap: 16, paddingTop: 8 },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: { width: 300, height: 300 * (396.58 / 1200) },
  tagline: { color: colors.textMuted, fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 300 },
  tips: { gap: 10 },
  tip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  tipIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
  },
  tipTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  tipDetail: { color: colors.textMuted, fontSize: 13 },
  actions: { gap: 12 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 56,
    borderRadius: radius.pill,
    experimental_backgroundImage: gradients.brand,
    boxShadow: '0 8px 24px rgba(152, 29, 206, 0.45)',
  },
  ctaPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  ctaLabel: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  center: { textAlign: 'center' },
});
