import { useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { countCards, playedCount, useDeck, useLegality, type DeckDetail, type DeckEntry, type SectionName } from '@/api/decks';
import { cardCount } from '@/api/binders';
import { addMissing, undoWishlist, useDeckComparison } from '@/api/wishlist';
import { DeckFacts, deckParts, EntryRow, PartTitle } from '@/components/deck-parts';
import { Icon } from '@/components/icon';
import { attempt, showToast } from '@/components/toast';
import { Button, EmptyState, ErrorState, Skeleton, usePullToRefresh } from '@/components/ui';
import { setPreferences } from '@/preferences';
import { ambient, colors, fonts, radius, type } from '@/theme';

// A deck: its art, whether it's legal, the cards by type, and one main action, Add cards (AppPlan, Phase A6).
export default function DeckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const deck = useDeck(id);
  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <Stack.Screen
        options={{
          title: deck.data?.name ?? '',
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/deck/${id}/settings`)}
              accessibilityRole="button"
              accessibilityLabel="Deck settings"
              hitSlop={12}
            >
              <Icon name="settings" size={22} tintColor={colors.text} />
            </Pressable>
          ),
        }}
      />
      {deck.isPending ? (
        <View style={styles.list}>
          <Skeleton style={{ height: 120 }} />
          <Skeleton style={{ height: 56 }} />
          <Skeleton style={{ height: 56 }} />
        </View>
      ) : deck.isError && !deck.data ? (
        <ErrorState message={deck.error.message} onRetry={() => void deck.refetch()} />
      ) : (
        <Cards deck={deck.data} refetch={deck.refetch} />
      )}
    </View>
  );
}

function Cards({ deck, refetch }: { deck: DeckDetail; refetch: () => Promise<unknown> }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [adding, setAdding] = useState(false);
  const empty = countCards([...deck.commander, ...deck.mainboard, ...deck.sideboard]) === 0;
  const parts = deckParts(deck);
  const refreshControl = usePullToRefresh(refetch);

  const open = (section: SectionName, entry: DeckEntry) =>
    router.push({ pathname: '/deck/[id]/card', params: { id: deck.id, section, scryfallId: entry.scryfallId, finish: entry.finish } });

  return (
    <>
      <SectionList
        sections={empty ? [] : parts}
        keyExtractor={(entry) => `${entry.scryfallId}-${entry.finish}`}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        stickySectionHeadersEnabled={false}
        refreshControl={refreshControl}
        ListHeaderComponent={<Header deck={deck} />}
        ListEmptyComponent={
          <EmptyState
            icon="style"
            title="No cards yet"
            body="Scan your cards, or find them by name."
          />
        }
        renderSectionHeader={({ section }) => <PartTitle title={section.title} />}
        renderSectionFooter={({ section }) =>
          section.section === 'commander' && section.data.length === 0 ? (
            <Text style={[type.body, styles.hint]}>Tap a legendary creature below and choose Commander.</Text>
          ) : null
        }
        renderItem={({ item, section }) => <EntryRow entry={item} onPress={() => open(section.section, item)} />}
      />

      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        {adding ? (
          <View style={styles.row}>
            <Button
              label="Scan"
              icon="document_scanner"
              onPress={() => {
                setAdding(false);
                setPreferences({ scanTo: { kind: 'deck', id: deck.id } }); // the scanner's tray saves here
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
                router.push({ pathname: '/deck/[id]/add', params: { id: deck.id } });
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

function Header({ deck }: { deck: DeckDetail }) {
  const legality = useLegality(deck);
  return (
    <View style={styles.header}>
      <DeckFacts deck={deck} warnings={legality.isSuccess ? legality.data : undefined} />
      {playedCount(deck) > 0 ? <Collection deck={deck} /> : null}
    </View>
  );
}

// How much of the deck is in your binders, and the rest onto the wishlist in one tap (A7).
function Collection({ deck }: { deck: DeckDetail }) {
  const router = useRouter();
  const comparison = useDeckComparison(deck);
  if (!comparison.data) return null;
  const { owned, missing } = comparison.data;

  async function add() {
    let result: Awaited<ReturnType<typeof addMissing>> | undefined;
    if (!(await attempt(async () => void (result = await addMissing(deck.id)))) || !result) return;
    const { added, changes } = result;
    showToast({
      message: added === 0 ? 'They’re already on your wishlist' : `Added ${cardCount(added)} to your wishlist`,
      onPress: () => router.push('/wishlist'),
      undo: added === 0 ? undefined : () => void attempt(() => undoWishlist(changes)),
    });
  }

  return (
    <View style={styles.collection}>
      <Icon name="collections_bookmark" size={20} tintColor={colors.lavender} />
      <Text style={[type.body, styles.flex]}>
        {missing === 0 ? 'You have every card' : `You have ${owned} of ${owned + missing}`}
      </Text>
      {missing > 0 ? (
        <Pressable onPress={() => void add()} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.link}>Add {missing} to wishlist</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  list: { padding: 20, gap: 4 },
  header: { gap: 12, marginBottom: 4 },
  collection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  link: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: colors.lavender },
  hint: { color: colors.textMuted, paddingVertical: 8 },
  flex: { flex: 1 },
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
