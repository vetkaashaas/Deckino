import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

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
import { Icon } from '@/components/icon';
import { Sheet } from '@/components/ui';
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
  const checked = count > 0 && deck.format !== 'casual' && warnings !== undefined;
  return (
    <>
      {cover ? <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" /> : null}
      <View style={styles.info}>
        <Text style={[type.label, styles.flex]}>
          {formatLabel(deck.format)} · {count} {count === 1 ? 'card' : 'cards'} · {formatPrice(deckValue(deck, currency), currency)}
        </Text>
        {checked ? <Legality format={formatLabel(deck.format)} warnings={warnings} /> : null}
        <ManaCost cost={pips.map((c) => `{${c}}`).join('')} size={18} />
      </View>
    </>
  );
}

// A word on the facts line: Legal, or Not legal, which opens what to fix.
function Legality({ format, warnings }: { format: string; warnings: string[] }) {
  const [open, setOpen] = useState(false);
  if (warnings.length === 0)
    return (
      <View style={[styles.legality, styles.legal]} accessibilityLabel={`Legal in ${format}`}>
        <Icon name="check_circle" size={16} tintColor={GOOD} />
        <Text style={[type.label, { color: GOOD }]}>Legal</Text>
      </View>
    );
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Not legal in ${format} yet. See why`}
        hitSlop={8}
        style={({ pressed }) => [styles.legality, styles.notLegal, pressed && { opacity: 0.8 }]}
      >
        <Icon name="info" size={16} tintColor={colors.warning} />
        <Text style={[type.label, { color: colors.warning }]}>Not legal</Text>
        <Icon name="chevron_right" size={16} tintColor={colors.warning} />
      </Pressable>
      <Sheet visible={open} title={`Not legal in ${format} yet`} onClose={() => setOpen(false)}>
        <View style={styles.warnings}>
          {warnings.map((warning) => (
            <View key={warning} style={styles.warning}>
              <Icon name="info" size={20} tintColor={colors.warning} />
              <Text style={[type.body, styles.flex]}>{warning}</Text>
            </View>
          ))}
        </View>
      </Sheet>
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
      {/* The count under the name, so the costs line up on the right. */}
      <View style={styles.flex}>
        <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
          {entry.card.name}
        </Text>
        {entry.quantity > 1 ? <Text style={styles.count}>×{entry.quantity}</Text> : null}
      </View>
      <ManaCost cost={entry.card.manaCost} size={14} />
    </Pressable>
  );
}

const GOOD = '#7BD88F';
const styles = StyleSheet.create({
  cover: { height: 140, borderRadius: radius.lg },
  info: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  legality: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  legal: { backgroundColor: 'rgba(123, 216, 143, 0.12)' },
  notLegal: { backgroundColor: 'rgba(242, 210, 122, 0.12)' },
  warnings: { gap: 14 },
  warning: { flexDirection: 'row', gap: 12 },
  part: { marginTop: 16, marginBottom: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 6, borderRadius: radius.md },
  thumb: { width: 36 },
  flex: { flex: 1 },
  count: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender },
});
