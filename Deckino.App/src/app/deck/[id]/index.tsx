import { useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  countCards,
  deckCover,
  deckValue,
  formatLabel,
  groupByType,
  playedCount,
  sectionLabel,
  useDeck,
  useLegality,
  type DeckDetail,
  type DeckEntry,
  type SectionName,
} from '@/api/decks';
import { CardImage, formatPrice, ManaCost } from '@/components/card-visuals';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
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
              <SymbolView name={{ ios: 'gearshape', android: 'settings' }} size={22} tintColor={colors.text} />
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
      ) : deck.isError ? (
        <ErrorState message={deck.error.message} onRetry={() => void deck.refetch()} />
      ) : (
        <Cards deck={deck.data} />
      )}
    </View>
  );
}

interface Part {
  title: string;
  section: SectionName;
  data: DeckEntry[];
}

function Cards({ deck }: { deck: DeckDetail }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [adding, setAdding] = useState(false);
  const commander = deck.format === 'commander';
  const empty = countCards([...deck.commander, ...deck.mainboard, ...deck.sideboard]) === 0;

  const parts: Part[] = [
    ...(commander || deck.commander.length > 0 ? [{ title: 'Commander', section: 'commander' as const, data: deck.commander }] : []),
    ...groupByType(deck.mainboard).map((g) => ({ title: `${g.label} (${countCards(g.entries)})`, section: 'mainboard' as const, data: g.entries })),
    ...(deck.sideboard.length > 0
      ? [{ title: `${sectionLabel('sideboard', deck.format)} (${countCards(deck.sideboard)})`, section: 'sideboard' as const, data: deck.sideboard }]
      : []),
  ];

  const open = (section: SectionName, entry: DeckEntry) =>
    router.push({ pathname: '/deck/[id]/card', params: { id: deck.id, section, scryfallId: entry.scryfallId, finish: entry.finish } });

  return (
    <>
      <SectionList
        sections={empty ? [] : parts}
        keyExtractor={(entry) => `${entry.scryfallId}-${entry.finish}`}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={<Header deck={deck} />}
        ListEmptyComponent={
          <EmptyState
            icon={{ ios: 'square.stack.3d.up', android: 'stacks' }}
            title="No cards yet"
            body="Scan your cards, or find them by name."
          />
        }
        renderSectionHeader={({ section }) => (
          <Text style={[type.label, styles.part]} accessibilityRole="header">
            {section.title}
          </Text>
        )}
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
              icon={{ ios: 'viewfinder', android: 'document_scanner' }}
              onPress={() => {
                setAdding(false);
                setPreferences({ scanDeckId: deck.id }); // the scanner's tray saves here
                router.navigate('/scan');
              }}
              style={styles.flex}
            />
            <Button
              label="Search"
              variant="secondary"
              icon={{ ios: 'magnifyingglass', android: 'search' }}
              onPress={() => {
                setAdding(false);
                router.push({ pathname: '/deck/[id]/add', params: { id: deck.id } });
              }}
              style={styles.flex}
            />
          </View>
        ) : (
          <Button label="Add cards" icon={{ ios: 'plus', android: 'add' }} onPress={() => setAdding(true)} />
        )}
      </View>
    </>
  );
}

// The cover art, "Commander · 100 cards · $412.50", the colours, and whether it's legal.
function Header({ deck }: { deck: DeckDetail }) {
  const { currency } = usePreferences();
  const legality = useLegality(deck);
  const cover = deckCover(deck);
  const count = playedCount(deck);
  const identity = new Set((deck.commander.length > 0 ? deck.commander : deck.mainboard).flatMap((e) => e.card.colorIdentity));
  const pips = ['W', 'U', 'B', 'R', 'G'].filter((c) => identity.has(c));
  const warnings = legality.data ?? [];
  return (
    <View style={styles.header}>
      {cover ? <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" /> : null}
      <View style={styles.info}>
        <Text style={[type.label, styles.flex]}>
          {formatLabel(deck.format)} · {count} {count === 1 ? 'card' : 'cards'} · {formatPrice(deckValue(deck, currency), currency)}
        </Text>
        <ManaCost cost={pips.map((c) => `{${c}}`).join('')} size={18} />
      </View>
      {count === 0 || deck.format === 'casual' || !legality.isSuccess ? null : warnings.length === 0 ? (
        <View style={[styles.legality, styles.legal]}>
          <SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle' }} size={20} tintColor={GOOD} />
          <Text style={type.body}>Legal in {formatLabel(deck.format)}</Text>
        </View>
      ) : (
        <View style={[styles.legality, styles.notLegal]}>
          <SymbolView name={{ ios: 'exclamationmark.circle', android: 'info' }} size={20} tintColor={WARN} />
          <View style={styles.flex}>
            <Text style={[type.body, { fontWeight: '600' }]}>Not legal in {formatLabel(deck.format)} yet</Text>
            {warnings.map((warning) => (
              <Text key={warning} style={type.label}>
                {warning}
              </Text>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function EntryRow({ entry, onPress }: { entry: DeckEntry; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={entry.quantity > 1 ? `${entry.card.name}, ${entry.quantity} copies` : undefined}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.thumb}>
        <CardImage uri={entry.card.smallImage ?? entry.card.image} name="" />
      </View>
      <Text style={[type.body, styles.flex, { fontWeight: '500' }]} numberOfLines={1}>
        {entry.card.name}
      </Text>
      <ManaCost cost={entry.card.manaCost} size={14} />
      {entry.quantity > 1 ? <Text style={styles.count}>×{entry.quantity}</Text> : null}
    </Pressable>
  );
}

const GOOD = '#7BD88F';
const WARN = '#F2D27A';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  list: { padding: 20, gap: 4 },
  header: { gap: 12, marginBottom: 4 },
  cover: { height: 140, borderRadius: radius.lg },
  info: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  legality: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: radius.md, borderWidth: 1 },
  legal: { backgroundColor: 'rgba(123, 216, 143, 0.10)', borderColor: 'rgba(123, 216, 143, 0.35)' },
  notLegal: { backgroundColor: 'rgba(242, 210, 122, 0.12)', borderColor: 'rgba(242, 210, 122, 0.35)' },
  part: { marginTop: 16, marginBottom: 4 },
  hint: { color: colors.textMuted, paddingVertical: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 6, borderRadius: radius.md },
  thumb: { width: 36 },
  flex: { flex: 1 },
  count: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender, minWidth: 28, textAlign: 'right' },
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
