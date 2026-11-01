import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, type Href } from 'expo-router';

import { cardCount } from '@/api/binders';
import { formatLabel, type DeckSummary } from '@/api/decks';
import { ManaCost } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { colors, fonts, radius, type } from '@/theme';

export const ART = 4 / 3; // Scryfall's art crops are about 626 × 457

/** A deck as its cover art with its colours on it, then its name, `byline` and "Format · 60 cards". */
export function DeckTile({ deck, width, byline, href = `/deck/${deck.id}` }: { deck: DeckSummary; width: number; byline: string; href?: Href }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => {
        Keyboard.dismiss();
        router.push(href);
      }}
      accessibilityRole="button"
      style={({ pressed }) => [{ width }, styles.tile, pressed && styles.pressed]}
    >
      <View style={styles.art}>
        {deck.cover ? (
          <Image source={{ uri: deck.cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        ) : (
          <Icon name="style" size={32} tintColor={colors.lavender} />
        )}
        {deck.colorIdentity.length > 0 ? (
          <View style={styles.colors}>
            <ManaCost cost={deck.colorIdentity.map((c) => `{${c}}`).join('')} size={16} />
          </View>
        ) : null}
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {deck.name}
      </Text>
      <Text style={type.label} numberOfLines={1}>
        {byline}
      </Text>
      <Text style={type.caption} numberOfLines={1}>
        {`${formatLabel(deck.format)} · ${cardCount(deck.cardCount)}`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { gap: 2 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  art: {
    aspectRatio: ART,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
    overflow: 'hidden',
    marginBottom: 6,
  },
  colors: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
  },
  name: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.text },
});
