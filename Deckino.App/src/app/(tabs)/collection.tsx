import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { useBinders, useCollectionPrices, type BinderSummary } from '@/api/binders';
import { useWishlist } from '@/api/wishlist';
import { useSignedIn } from '@/api/session';
import { formatPrice } from '@/components/card-visuals';
import { CollectionValue, WishlistRow } from '@/components/collection-summary';
import { MoverRow } from '@/components/price-mover';
import { Button, EmptyState, ErrorState, ListRow, Screen, Skeleton, usePullToRefresh } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, radius, type } from '@/theme';

// The collection's value, the binders, the wishlist (A7), and this week's biggest price moves (AppPlan, Phase A4).
export default function CollectionScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  if (!signedIn) {
    return (
      <Screen title="Collection">
        <EmptyState
          icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
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
  if (binders.data.length === 0 && !wishlist.data?.length) {
    return (
      <EmptyState
        icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
        title="Make your first binder"
        body="A binder holds your cards: one for trades, one per box, whatever suits you."
        action={{ label: 'New binder', onPress: () => router.push('/binder/new') }}
      />
    );
  }

  const movers = prices.data?.movers.slice(0, 5) ?? [];
  return (
    <FlatList
      data={binders.data}
      keyExtractor={(binder) => binder.id}
      contentContainerStyle={styles.content}
      refreshControl={refreshControl}
      ListHeaderComponent={
        <View style={styles.header}>
          <CollectionValue />
          <Button label="New binder" variant="secondary" icon={{ ios: 'plus', android: 'add' }} onPress={() => router.push('/binder/new')} />
          <WishlistRow />
        </View>
      }
      renderItem={({ item }) => <BinderRow binder={item} currency={currency} />}
      ListFooterComponent={
        movers.length > 0 ? (
          <View style={styles.movers}>
            <Text style={type.heading}>Biggest moves this week</Text>
            {movers.map((mover) => (
              <MoverRow key={`${mover.card.id}-${mover.finish}`} mover={mover} currency={currency} />
            ))}
          </View>
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
            <SymbolView name={{ ios: 'books.vertical', android: 'collections_bookmark' }} size={22} tintColor={colors.lavender} />
          )}
        </View>
      }
      title={binder.name}
      detail={binder.cardCount > 0 ? `${cards} · ${formatPrice(binder.value, currency)}` : 'Empty'}
      trailing={<SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={18} tintColor={colors.textDim} />}
      onPress={() => router.push(`/binder/${binder.id}`)}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 140, gap: 4 },
  header: { gap: 12, marginBottom: 8 },
  art: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
    overflow: 'hidden',
  },
  movers: { gap: 4, marginTop: 24 },
});
