import { ScrollView, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { addCards, cardCount, finishFor, removeCards, useBinders } from '@/api/binders';
import { countCards } from '@/api/decks';
import { changeWishlist, undoWishlist, useWishlist, type WishlistChange } from '@/api/wishlist';
import { Icon } from '@/components/icon';
import { attempt, showToast } from '@/components/toast';
import { ListRow } from '@/components/ui';
import { getPreferences } from '@/preferences';
import { colors, type } from '@/theme';

// Wanted cards you've got now: into a binder (non-foil, with the Profile's condition and language, as Add by name),
// off the wishlist. Tap a binder and it's done (with undo). Laid out as a binder's Move.
export default function MoveWantedScreen() {
  const { ids } = useLocalSearchParams<{ ids: string }>();
  const router = useRouter();
  const binders = useBinders().data;
  const wantedIds = ids.split(',');
  const entries = useWishlist().data?.filter((e) => wantedIds.includes(e.id)) ?? [];
  const count = countCards(entries);

  async function move(to: { id: string; name: string }) {
    const { condition, language } = getPreferences();
    let added: string[] = [];
    let applied: WishlistChange[] = [];
    const moved = await attempt(async () => {
      added = await addCards(
        to.id,
        entries.map((e) => ({
          card: { scryfallId: e.scryfallId, finish: finishFor(e.card.finishes, 'nonfoil'), condition, language },
          copies: e.quantity,
        })),
      );
      try {
        applied = await changeWishlist(entries.map((e) => ({ scryfallId: e.scryfallId, quantity: -e.quantity })));
      } catch (error) {
        await removeCards(to.id, added).catch(() => undefined); // not in both places
        throw error;
      }
    });
    if (moved) {
      router.dismissTo('/wishlist');
      showToast({
        message: `Moved ${cardCount(count)} to ${to.name}`,
        undo: () => void attempt(() => Promise.all([removeCards(to.id, added), undoWishlist(applied)])),
      });
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[type.body, styles.note]}>Move {cardCount(count)} to:</Text>
      {binders?.map((binder) => (
        <ListRow
          key={binder.id}
          title={binder.name}
          detail={cardCount(binder.cardCount)}
          onPress={() => entries.length === wantedIds.length && void move(binder)}
        />
      ))}
      <ListRow
        leading={<Icon name="add" size={22} tintColor={colors.lavender} />}
        title="New binder"
        onPress={() => router.push({ pathname: '/binder/new', params: { then: 'back' } })}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 4 },
  note: { color: colors.textMuted, marginBottom: 8 },
});
