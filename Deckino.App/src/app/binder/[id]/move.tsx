import { ScrollView, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { cardCount, moveCards, useBinders } from '@/api/binders';
import { attempt, showToast } from '@/components/toast';
import { EmptyState, ListRow } from '@/components/ui';
import { colors, type } from '@/theme';

// Where to move some cards: the other binders. Tap one and it's done (with undo).
export default function MoveScreen() {
  const { id, ids } = useLocalSearchParams<{ id: string; ids: string }>();
  const router = useRouter();
  const others = useBinders().data?.filter((b) => b.id !== id);
  const cardIds = ids.split(',');

  async function move(to: { id: string; name: string }) {
    if (await attempt(() => moveCards(id, cardIds, to.id))) {
      router.dismissTo({ pathname: '/binder/[id]', params: { id } });
      showToast({
        message: `Moved ${cardCount(cardIds.length)} to ${to.name}`,
        undo: () => void attempt(() => moveCards(to.id, cardIds, id)),
      });
    }
  }

  if (others?.length === 0) {
    return (
      <EmptyState
        icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
        title="No other binder yet"
        body="Make another binder to move these cards into."
        action={{ label: 'New binder', onPress: () => router.push({ pathname: '/binder/new', params: { then: 'back' } }) }}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[type.body, styles.note]}>Move {cardCount(cardIds.length)} to:</Text>
      {others?.map((binder) => (
        <ListRow key={binder.id} title={binder.name} detail={cardCount(binder.cardCount)} onPress={() => void move(binder)} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 4 },
  note: { color: colors.textMuted, marginBottom: 8 },
});
