import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';

import { useBinders, useCollectionMovers, useCollectionPrices, type BinderSummary } from '@/api/binders';
import { useWishlist } from '@/api/wishlist';
import { useSignedIn } from '@/api/session';
import { formatPrice } from '@/components/card-visuals';
import { CollectionValue, WishlistRow } from '@/components/collection-summary';
import { Icon } from '@/components/icon';
import { Pager, PagerTab, PagerTabs, usePager } from '@/components/pager';
import { MoverRow } from '@/components/price-mover';
import { Button, EmptyState, ErrorState, ListRow, Screen, Skeleton, usePullToRefresh } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// The collection's value, the binders and the wishlist (A7), and on a second page your cards' price moves this week
// (AppPlan, Phase A4).
export default function CollectionScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  if (!signedIn) {
    return (
      <Screen title="Collection">
        <EmptyState
          icon="collections_bookmark"
          title="Your binders, in your pocket"
          body="Sign in to sort your cards into binders and see what they're worth."
          action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
        />
      </Screen>
    );
  }
  return (
    <Screen title="Collection">
      <Binders />
    </Screen>
  );
}

function Binders() {
  const router = useRouter();
  const { currency } = usePreferences();
  const binders = useBinders(currency);
  const prices = useCollectionPrices(currency);
  const wishlist = useWishlist();
  const refreshControl = usePullToRefresh(() => Promise.all([binders.refetch(), prices.refetch(), wishlist.refetch()]));
  const [page, setPage] = useState(0);
  const position = usePager(0);

  if (binders.isPending) {
    return (
      <View style={styles.content}>
        <Skeleton style={{ height: 96, borderRadius: radius.lg }} />
        <Skeleton style={{ height: 56 }} />
        <Skeleton style={{ height: 56 }} />
      </View>
    );
  }
  if (binders.isError && !binders.data) return <ErrorState message={binders.error.message} onRetry={() => void binders.refetch()} />;
  const empty = binders.data.length === 0;

  // The value stays put over two pages: what you have (the binders, then the wishlist: cards you want, not ones you
  // have), and how your cards' prices moved this week. With no binders yet, the first one is the page's one action,
  // and the wishlist is still a tap away under it.
  return (
    <>
      {empty ? null : (
        <View style={styles.value}>
          <CollectionValue />
        </View>
      )}
      <PagerTabs>
        {['Binders', 'Prices'].map((label, at) => (
          <PagerTab key={label} label={label} at={at} selected={page === at} x={position.x} onPress={() => setPage(at)} />
        ))}
        {page === 0 && !empty ? (
          <View style={styles.action}>
            <Pressable
              onPress={() => router.push('/binder/new')}
              accessibilityRole="button"
              accessibilityLabel="New binder"
              hitSlop={8}
              style={({ pressed }) => [styles.new, pressed && { opacity: 0.7 }]}
            >
              <Icon name="add" size={18} tintColor={colors.violet} />
              <Text style={styles.link}>New binder</Text>
            </Pressable>
          </View>
        ) : null}
      </PagerTabs>
      <Pager page={page} onPage={setPage} position={position} style={styles.flex}>
        <FlatList
          data={binders.data}
          keyExtractor={(binder) => binder.id}
          contentContainerStyle={styles.content}
          refreshControl={refreshControl}
          renderItem={({ item }) => <BinderRow binder={item} currency={currency} />}
          ListEmptyComponent={
            <EmptyState
              icon="collections_bookmark"
              title="Make your first binder"
              body="A binder holds your cards: one for trades, one per box, whatever suits you."
              action={{ label: 'New binder', onPress: () => router.push('/binder/new') }}
            />
          }
          ListFooterComponent={
            <View style={styles.wishlist}>
              <WishlistRow />
            </View>
          }
        />
        <Movers currency={currency} />
      </Pager>
    </>
  );
}

// Every card of yours whose price changed this week, by how much it moved your total, a page at a time.
function Movers({ currency }: { currency: 'usd' | 'eur' }) {
  const prices = useCollectionPrices(currency);
  const movers = useCollectionMovers(currency);
  const refreshControl = usePullToRefresh(() => Promise.all([prices.refetch(), movers.refetch()]));
  const shown = movers.data?.pages.flatMap((page) => page.movers) ?? [];
  return (
    <FlatList
      data={shown}
      keyExtractor={(mover) => `${mover.card.id}-${mover.finish}`}
      contentContainerStyle={styles.content}
      refreshControl={refreshControl}
      renderItem={({ item }) => <MoverRow mover={item} currency={currency} />}
      ListHeaderComponent={
        shown.length > 0 ? <Text style={[type.label, styles.intro]}>This week's changes to your cards, biggest first.</Text> : null
      }
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (movers.hasNextPage && !movers.isFetchingNextPage) void movers.fetchNextPage();
      }}
      ListEmptyComponent={
        movers.isPending ? (
          <ActivityIndicator color={colors.lavender} style={styles.more} />
        ) : movers.isError ? (
          <ErrorState message={movers.error.message} onRetry={() => void movers.refetch()} />
        ) : (
          <Text style={type.label}>None of your cards changed price this week.</Text>
        )
      }
      ListFooterComponent={
        movers.isFetchingNextPage ? (
          <ActivityIndicator color={colors.lavender} style={styles.more} />
        ) : movers.isFetchNextPageError ? (
          <Button label="Couldn't load more. Try again" variant="secondary" onPress={() => void movers.fetchNextPage()} style={styles.more} />
        ) : null
      }
    />
  );
}

function BinderRow({ binder, currency }: { binder: BinderSummary; currency: 'usd' | 'eur' }) {
  const router = useRouter();
  const cards = `${binder.cardCount} ${binder.cardCount === 1 ? 'card' : 'cards'}`;
  return (
    <ListRow
      leading={
        <View style={styles.art}>
          {binder.cover ? (
            <Image source={{ uri: binder.cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Icon name="collections_bookmark" size={22} tintColor={colors.lavender} />
          )}
        </View>
      }
      title={binder.name}
      detail={binder.cardCount > 0 ? `${cards} · ${formatPrice(binder.value, currency)}` : 'Empty'}
      trailing={<Icon name="chevron_right" size={18} tintColor={colors.textDim} />}
      onPress={() => router.push(`/binder/${binder.id}`)}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 140, gap: 4 },
  value: { paddingHorizontal: 20, paddingBottom: 14 },
  action: { flex: 1, alignItems: 'flex-end', paddingBottom: 6 },
  new: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  flex: { flex: 1 },
  more: { marginVertical: 16 },
  link: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.violet },
  wishlist: { marginTop: 16 },
  intro: { marginBottom: 8 },
  art: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
    overflow: 'hidden',
  },
});
