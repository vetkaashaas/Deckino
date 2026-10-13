import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { formatLabel, useDecks, type DeckSummary } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { ManaCost } from '@/components/card-visuals';
import { Button, EmptyState, ErrorState, ListRow, Screen, Skeleton } from '@/components/ui';
import { colors, radius } from '@/theme';

// Your decks, newest change first (AppPlan, Phase A6).
export default function DecksScreen() {
  const router = useRouter();
  if (!useSignedIn()) {
    return (
      <Screen title="Decks">
        <EmptyState
          icon={{ ios: 'square.stack.3d.up', android: 'stacks' }}
          title="Build decks on the go"
          body="Sign in to build decks, scan cards into them and check they're legal."
          action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
        />
      </Screen>
    );
  }
  return (
    <Screen title="Decks">
      <Decks />
    </Screen>
  );
}

function Decks() {
  const router = useRouter();
  const decks = useDecks();
  if (decks.isPending) {
    return (
      <View style={styles.content}>
        <Skeleton style={{ height: 52 }} />
        <Skeleton style={{ height: 56 }} />
        <Skeleton style={{ height: 56 }} />
      </View>
    );
  }
  if (decks.isError) return <ErrorState message={decks.error.message} onRetry={() => void decks.refetch()} />;
  if (decks.data.length === 0) {
    return (
      <EmptyState
        icon={{ ios: 'square.stack.3d.up', android: 'stacks' }}
        title="Make your first deck"
        body="Pick a format, then add cards by scanning them or by name."
        action={{ label: 'New deck', onPress: () => router.push('/deck/new') }}
      />
    );
  }
  return (
    <FlatList
      data={decks.data}
      keyExtractor={(deck) => deck.id}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={decks.isRefetching}
          onRefresh={() => void decks.refetch()}
          tintColor={colors.lavender}
          colors={[colors.purple]}
        />
      }
      ListHeaderComponent={
        <Button
          label="New deck"
          variant="secondary"
          icon={{ ios: 'plus', android: 'add' }}
          onPress={() => router.push('/deck/new')}
          style={styles.new}
        />
      }
      renderItem={({ item }) => <DeckRow deck={item} />}
    />
  );
}

function DeckRow({ deck }: { deck: DeckSummary }) {
  const router = useRouter();
  return (
    <ListRow
      leading={
        <View style={styles.art}>
          {deck.cover ? (
            <Image source={{ uri: deck.cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <SymbolView name={{ ios: 'square.stack.3d.up', android: 'stacks' }} size={22} tintColor={colors.lavender} />
          )}
        </View>
      }
      title={deck.name}
      detail={`${formatLabel(deck.format)} · ${deck.cardCount} ${deck.cardCount === 1 ? 'card' : 'cards'} · ${updated(deck.updatedAt)}`}
      trailing={<ManaCost cost={deck.colorIdentity.map((c) => `{${c}}`).join('')} size={16} />}
      onPress={() => router.push(`/deck/${deck.id}`)}
    />
  );
}

/** "Updated today", "Updated 2 days ago", then the date. */
function updated(at: string) {
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
  if (days < 1) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 30) return `Updated ${days} days ago`;
  return `Updated ${new Date(at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 140, gap: 4 },
  new: { marginBottom: 8 },
  art: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
    overflow: 'hidden',
  },
});
