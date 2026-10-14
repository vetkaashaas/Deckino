import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';

import {
  countCards,
  deckCover,
  deckValue,
  formatLabel,
  groupByType,
  playedCount,
  sectionLabel,
  type DeckDetail,
  type DeckEntry,
  type SectionName,
} from '@/api/decks';
import { CardImage, formatPrice, ManaCost } from '@/components/card-visuals';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// What a deck looks like wherever it's shown: your own (deck/[id]) and a public one (public/deck/[id]).

export interface DeckPart {
  title: string;
  section: SectionName;
  data: DeckEntry[];
}

/** The commander, the main deck by card type, then the sideboard, each with its count. */
export function deckParts(deck: DeckDetail): DeckPart[] {
  return [
    ...(deck.format === 'commander' || deck.commander.length > 0 ? [{ title: 'Commander', section: 'commander' as const, data: deck.commander }] : []),
    ...groupByType(deck.mainboard).map((g) => ({ title: `${g.label} (${countCards(g.entries)})`, section: 'mainboard' as const, data: g.entries })),
    ...(deck.sideboard.length > 0
      ? [{ title: `${sectionLabel('sideboard', deck.format)} (${countCards(deck.sideboard)})`, section: 'sideboard' as const, data: deck.sideboard }]
      : []),
  ];
}

/** The cover art, "Commander · 100 cards · $412.50" with the colours, and whether it's legal (`warnings` undefined: still checking). */
export function DeckFacts({ deck, warnings }: { deck: DeckDetail; warnings: string[] | undefined }) {
  const { currency } = usePreferences();
  const cover = deckCover(deck);
  const count = playedCount(deck);
  const identity = new Set((deck.commander.length > 0 ? deck.commander : deck.mainboard).flatMap((e) => e.card.colorIdentity));
  const pips = ['W', 'U', 'B', 'R', 'G'].filter((c) => identity.has(c));
  return (
    <>
      {cover ? <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" /> : null}
      <View style={styles.info}>
        <Text style={[type.label, styles.flex]}>
          {formatLabel(deck.format)} · {count} {count === 1 ? 'card' : 'cards'} · {formatPrice(deckValue(deck, currency), currency)}
        </Text>
        <ManaCost cost={pips.map((c) => `{${c}}`).join('')} size={18} />
      </View>
      {count === 0 || deck.format === 'casual' || warnings === undefined ? null : warnings.length === 0 ? (
        <View style={[styles.legality, styles.legal]}>
          <SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle' }} size={20} tintColor={GOOD} />
          <Text style={type.body}>Legal in {formatLabel(deck.format)}</Text>
        </View>
      ) : (
        <View style={[styles.legality, styles.notLegal]}>
          <SymbolView name={{ ios: 'exclamationmark.circle', android: 'info' }} size={20} tintColor={colors.warning} />
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
    </>
  );
}

export function PartTitle({ title }: { title: string }) {
  return (
    <Text style={[type.label, styles.part]} accessibilityRole="header">
      {title}
    </Text>
  );
}

export function EntryRow({ entry, onPress }: { entry: DeckEntry; onPress: () => void }) {
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
const styles = StyleSheet.create({
  cover: { height: 140, borderRadius: radius.lg },
  info: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  legality: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: radius.md, borderWidth: 1 },
  legal: { backgroundColor: 'rgba(123, 216, 143, 0.10)', borderColor: 'rgba(123, 216, 143, 0.35)' },
  notLegal: { backgroundColor: 'rgba(242, 210, 122, 0.12)', borderColor: 'rgba(242, 210, 122, 0.35)' },
  part: { marginTop: 16, marginBottom: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 6, borderRadius: radius.md },
  thumb: { width: 36 },
  flex: { flex: 1 },
  count: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender, minWidth: 28, textAlign: 'right' },
});
