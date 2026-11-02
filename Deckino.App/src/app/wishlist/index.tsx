import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cardCount } from '@/api/binders';
import { countCards } from '@/api/decks';
import { changeWishlist, undoWishlist, useWishlist, wantedPrice, wishlistValue, type WishlistChange, type WishlistEntry } from '@/api/wishlist';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { attempt, showToast } from '@/components/toast';
import { Backdrop, Button, EmptyState, ErrorState, Skeleton, usePullToRefresh } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// The cards you want, and what they'd cost; cards added by Scan or by name (AppPlan, Phase A7). Select some to
// remove them, or to move them into a binder once you've got them.
export default function WishlistScreen() {
  const wishlist = useWishlist();
  return (
    <View style={styles.screen}>
      <Backdrop />
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
  const refreshControl = usePullToRefresh(refetch);
  const count = countCards(list);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null: not selecting
  const chosen = list.filter((entry) => selected?.has(entry.id));
  const chosenCount = countCards(chosen);
  if (selected?.size && chosen.length === 0) setSelected(null); // they were moved away: nothing left to act on

  const toggle = (entry: WishlistEntry) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(entry.id)) next.add(entry.id);
      return next;
    });

  async function removeChosen() {
    let applied: WishlistChange[] = [];
    const removed = await attempt(async () => {
      applied = await changeWishlist(chosen.map((e) => ({ scryfallId: e.scryfallId, quantity: -e.quantity })));
    });
    if (removed) {
      setSelected(null);
      showToast({ message: `Removed ${cardCount(chosenCount)}`, undo: () => void attempt(() => undoWishlist(applied)) });
    }
  }

  return (
    <>
      <FlatList
        data={list}
        keyExtractor={(entry) => entry.id}
        refreshControl={refreshControl}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        ListHeaderComponent={
          list.length > 0 ? (
            <View style={styles.header}>
              <Text style={type.label}>
                {cardCount(count)} · {formatPrice(wishlistValue(list, currency), currency)}
              </Text>
              <Pressable
                onPress={() => setSelected(selected ? null : new Set())}
                accessibilityRole="button"
                hitSlop={8}
                style={({ pressed }) => [styles.select, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.selectLabel}>{selected ? 'Done' : 'Select'}</Text>
              </Pressable>
            </View>
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
          const checked = selected ? selected.has(item.id) : null;
          return (
            <Pressable
              onPress={() => (selected ? toggle(item) : router.push({ pathname: '/wishlist/card', params: { id: item.id } }))}
              onLongPress={() => {
                setSelected((current) => current ?? new Set());
                toggle(item);
              }}
              accessibilityRole={checked === null ? 'button' : 'checkbox'}
              accessibilityState={checked === null ? undefined : { checked }}
              accessibilityLabel={item.quantity > 1 ? `${item.card.name}, ${item.quantity} copies` : undefined}
              style={({ pressed }) => [styles.card, checked && styles.cardSelected, pressed && { opacity: 0.85 }]}
            >
              {checked !== null ? (
                <Icon
                  name={checked ? 'check_circle' : 'radio_button_unchecked'}
                  size={22}
                  tintColor={checked ? colors.violet : colors.textDim}
                />
              ) : null}
              <View style={styles.thumb}>
                <CardImage uri={item.card.smallImage ?? item.card.image} name="" />
              </View>
              <View style={styles.flex}>
                <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
                  {item.card.name}
                </Text>
                {item.quantity > 1 ? <Text style={styles.count}>×{item.quantity}</Text> : null}
                <SetSymbol setCode={item.card.setCode} rarity={item.card.rarity} size={14} withCode />
              </View>
              <Text style={styles.price}>{formatPrice(price === null ? null : price * item.quantity, currency)}</Text>
            </Pressable>
          );
        }}
      />

      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        {selected ? (
          <View style={styles.row}>
            <Button
              label={chosenCount > 0 ? `Move ${chosenCount}` : 'Move'}
              variant="secondary"
              icon="drive_file_move"
              onPress={() =>
                chosen.length > 0 && router.push({ pathname: '/wishlist/move', params: { ids: chosen.map((e) => e.id).join(',') } })
              }
              style={styles.flex}
            />
            <Button
              label={chosenCount > 0 ? `Remove ${chosenCount}` : 'Remove'}
              variant="remove"
              icon="delete"
              onPress={() => chosen.length > 0 && void removeChosen()}
              style={styles.flex}
            />
          </View>
        ) : (
          <View style={styles.row}>
            <Button
              label="Scan"
              icon="document_scanner"
              onPress={() => {
                setPreferences({ scanTo: { kind: 'wishlist' } }); // the scanner's tray saves here
                router.navigate('/scan');
              }}
              style={styles.flex}
            />
            <Button
              label="Add by name"
              variant="secondary"
              icon="keyboard"
              onPress={() => {
                router.push('/wishlist/add');
              }}
              style={styles.flex}
            />
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: 20, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  select: { paddingHorizontal: 4, paddingVertical: 6 },
  selectLabel: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.lavender },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  cardSelected: { borderColor: colors.violet, backgroundColor: 'rgba(176, 89, 255, 0.10)' },
  thumb: { width: 44 },
  flex: { flex: 1 },
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
