import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cardCount } from '@/api/binders';
import { countCards } from '@/api/decks';
import { useWishlist, wantedPrice, wishlistValue, type WishlistEntry } from '@/api/wishlist';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { Button, EmptyState, ErrorState, Skeleton, usePullToRefresh } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
import { ambient, colors, fonts, radius, type } from '@/theme';

// The cards you want, and what they'd cost; one main action, Add cards (AppPlan, Phase A7).
export default function WishlistScreen() {
  const wishlist = useWishlist();
  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      {wishlist.isPending ? (
        <View style={styles.list}>
          <Skeleton style={{ height: 20, width: '50%' }} />
          <Skeleton style={{ height: 64 }} />
          <Skeleton style={{ height: 64 }} />
        </View>
      ) : wishlist.isError && !wishlist.data ? (
        <ErrorState message={wishlist.error.message} onRetry={() => void wishlist.refetch()} />
      ) : (
        <Wanted list={wishlist.data} refetch={wishlist.refetch} />
      )}
    </View>
  );
}

function Wanted({ list, refetch }: { list: WishlistEntry[]; refetch: () => Promise<unknown> }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { currency } = usePreferences();
  const [adding, setAdding] = useState(false);
  const refreshControl = usePullToRefresh(refetch);
  const count = countCards(list);

  return (
    <>
      <FlatList
        data={list}
        keyExtractor={(entry) => entry.id}
        refreshControl={refreshControl}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        ListHeaderComponent={
          list.length > 0 ? (
            <Text style={[type.label, styles.header]}>
              {cardCount(count)} · {formatPrice(wishlistValue(list, currency), currency)}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon="favorite"
            title="Nothing on your wishlist"
            body="Add the cards you're after, and the scanner tells you when you see one."
          />
        }
        renderItem={({ item }) => {
          const price = wantedPrice(item.card, currency);
          return (
            <Pressable
              onPress={() => router.push({ pathname: '/wishlist/card', params: { id: item.id } })}
              accessibilityRole="button"
              accessibilityLabel={item.quantity > 1 ? `${item.card.name}, ${item.quantity} copies` : undefined}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
            >
              <View style={styles.thumb}>
                <CardImage uri={item.card.smallImage ?? item.card.image} name="" />
              </View>
              <View style={styles.flex}>
                <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
                  {item.card.name}
                </Text>
                <SetSymbol setCode={item.card.setCode} rarity={item.card.rarity} size={14} withCode />
              </View>
              <View style={styles.end}>
                <Text style={styles.price}>{formatPrice(price === null ? null : price * item.quantity, currency)}</Text>
                {item.quantity > 1 ? <Text style={styles.count}>×{item.quantity}</Text> : null}
              </View>
            </Pressable>
          );
        }}
      />

      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        {adding ? (
          <View style={styles.row}>
            <Button
              label="Scan"
              icon="document_scanner"
              onPress={() => {
                setAdding(false);
                setPreferences({ scanTo: { kind: 'wishlist' } }); // the scanner's tray saves here
                router.navigate('/scan');
              }}
              style={styles.flex}
            />
            <Button
              label="Search"
              variant="secondary"
              icon="search"
              onPress={() => {
                setAdding(false);
                router.push('/wishlist/add');
              }}
              style={styles.flex}
            />
          </View>
        ) : (
          <Button label="Add cards" icon="add" onPress={() => setAdding(true)} />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  list: { padding: 20, gap: 8 },
  header: { marginBottom: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, borderRadius: radius.md },
  thumb: { width: 44 },
  flex: { flex: 1 },
  end: { alignItems: 'flex-end', gap: 2 },
  price: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.text },
  count: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: 'rgba(11, 6, 16, 0.94)',
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  row: { flexDirection: 'row', gap: 12 },
});
