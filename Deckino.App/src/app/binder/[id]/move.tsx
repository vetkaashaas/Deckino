import { ScrollView, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { cardCount, moveCards, removeCards, restoreCards, useBinder, useBinders } from '@/api/binders';
import { countCards } from '@/api/decks';
import { changeWishlist, undoWishlist, useWishlist, type WishlistChange } from '@/api/wishlist';
import { Icon } from '@/components/icon';
import { attempt, showToast } from '@/components/toast';
import { ListRow } from '@/components/ui';
import { colors, type } from '@/theme';

// Where to move some cards: another binder, a new one, or back to the wishlist (a card you let go and want again).
// Tap one and it's done (with undo). Laid out as the scan tray's picker.
export default function MoveScreen() {
  const { id, ids } = useLocalSearchParams<{ id: string; ids: string }>();
  const router = useRouter();
  const others = useBinders().data?.filter((b) => b.id !== id);
  const wishlist = useWishlist().data;
  const cardIds = ids.split(',');
  const copies = useBinder(id).data?.cards.filter((c) => cardIds.includes(c.id)) ?? [];

  async function move(to: { id: string; name: string }) {
    if (await attempt(() => moveCards(id, cardIds, to.id))) {
      router.dismissTo({ pathname: '/binder/[id]', params: { id } });
      showToast({
        message: `Moved ${cardCount(cardIds.length)} to ${to.name}`,
        undo: () => void attempt(() => moveCards(to.id, cardIds, id)),
      });
    }
  }

  // The wishlist keeps only the printing: undo puts the copies back as they were (condition, finish, notes).
  async function toWishlist() {
    let applied: WishlistChange[] = [];
    const moved = await attempt(async () => {
      applied = await changeWishlist(copies.map((c) => ({ scryfallId: c.scryfallId, quantity: 1 })));
      try {
        await removeCards(id, cardIds);
      } catch (error) {
        await undoWishlist(applied).catch(() => undefined); // not in both places
        throw error;
      }
    });
    if (moved) {
      router.dismissTo({ pathname: '/binder/[id]', params: { id } });
      showToast({
        message: `Moved ${cardCount(cardIds.length)} to your wishlist`,
        undo: () => void attempt(() => Promise.all([restoreCards(id, copies), undoWishlist(applied)])),
      });
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[type.body, styles.note]}>Move {cardCount(cardIds.length)} to:</Text>
      <Text style={[type.label, styles.heading]} accessibilityRole="header">
        Binders
      </Text>
      {others?.map((binder) => (
        <ListRow key={binder.id} title={binder.name} detail={cardCount(binder.cardCount)} onPress={() => void move(binder)} />
      ))}
      <ListRow
        leading={<Icon name="add" size={22} tintColor={colors.lavender} />}
        title="New binder"
        onPress={() => router.push({ pathname: '/binder/new', params: { then: 'back' } })}
      />
      <Text style={[type.label, styles.heading]} accessibilityRole="header">
        Cards you want
      </Text>
      <ListRow
        leading={<Icon name="favorite" size={22} tintColor={colors.lavender} />}
        title="Wishlist"
        detail={wishlist ? cardCount(countCards(wishlist)) : undefined}
        onPress={() => copies.length === cardIds.length && void toWishlist()}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 4 },
  note: { color: colors.textMuted },
  heading: { marginTop: 12, marginBottom: 4 },
});
