import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';

import type { CardSummary } from '@/api/cards';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, rarityColors, type } from '@/theme';

const CARD_RATIO = 63 / 88; // a Magic card's width / height

/** A card image with the card's own rounded corners, and a soft placeholder while it loads. */
export function CardImage({
  uri,
  name,
  style,
  transition = 150,
}: {
  uri: string | null;
  name: string;
  style?: StyleProp<ViewStyle>;
  transition?: number;
}) {
  return (
    <View style={[styles.cardFrame, style]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={transition}
          recyclingKey={uri}
          accessibilityLabel={name}
          accessible
        />
      ) : (
        <Text style={[type.label, styles.noImage]}>{name}</Text>
      )}
    </View>
  );
}

/** A search result: the full card image (the hero), its name and price. */
export function CardTile({ card, onPress }: { card: CardSummary; onPress: () => void }) {
  const { currency } = usePreferences();
  const price = formatPrice(currency === 'eur' ? card.eur : card.usd, currency);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${card.name}, ${card.setName}, ${price}`}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
    >
      <CardImage uri={card.image} name={card.name} />
      <View style={styles.tileText}>
        <Text style={styles.tileName} numberOfLines={1}>
          {card.name}
        </Text>
        <Text style={type.label}>{price}</Text>
      </View>
    </Pressable>
  );
}

export function formatPrice(value: number | null, currency: 'usd' | 'eur'): string {
  if (value === null) return '—';
  return `${currency === 'usd' ? '$' : '€'}${value.toFixed(2)}`;
}

const symbolUrl = (symbol: string) => `https://svgs.scryfall.io/card-symbols/${symbol.replace(/\//g, '')}.svg`;

/** A mana cost ("{2}{R}{R}") as Scryfall's symbols. */
export function ManaCost({ cost, size = 18 }: { cost: string | null; size?: number }) {
  if (!cost) return null;
  const symbols = cost.match(/\{[^}]+\}/g) ?? [];
  return (
    <View style={styles.symbols} accessibilityLabel={cost} accessible>
      {symbols.map((symbol, index) => (
        <Image
          key={`${symbol}-${index}`}
          source={{ uri: symbolUrl(symbol.slice(1, -1)) }}
          style={{ width: size, height: size }}
        />
      ))}
    </View>
  );
}

/** Rules text with its symbols ({T}, {R}…) drawn inline. */
export function RulesText({ text, style }: { text: string; style?: object }) {
  const size = 15;
  return (
    <Text style={[type.body, style]}>
      {text.split(/(\{[^}]+\})/).map((part, index) =>
        /^\{[^}]+\}$/.test(part) ? (
          <Image
            key={index}
            source={{ uri: symbolUrl(part.slice(1, -1)) }}
            style={{ width: size, height: size }}
            accessibilityLabel={part}
          />
        ) : (
          part
        ),
      )}
    </Text>
  );
}

/**
 * The set's symbol in its rarity colour; the set code when Scryfall has no symbol for it. `withCode` follows the
 * symbol with the code (and `detail`): "⚡ M10 · Near Mint", or "M10 · Near Mint" without a symbol, never the code twice.
 */
export function SetSymbol({
  setCode,
  rarity,
  size = 22,
  withCode,
  detail,
}: {
  setCode: string;
  rarity: string;
  size?: number;
  withCode?: boolean;
  detail?: string;
}) {
  const [failed, setFailed] = useState(false);
  const color = rarityColors[rarity] ?? colors.textMuted;
  const code = setCode.toUpperCase();
  const text = withCode ? [code, detail].filter(Boolean).join(' · ') : null;
  if (failed) {
    return text ? (
      <Text style={[type.label, styles.shrink]} numberOfLines={1}>
        <Text style={{ color }}>{code}</Text>
        {text.slice(code.length)}
      </Text>
    ) : (
      <Text style={[styles.setCode, { color }]}>{code}</Text>
    );
  }
  const symbol = (
    <Image
      source={{ uri: `https://svgs.scryfall.io/sets/${setCode}.svg` }}
      style={{ width: size, height: size }}
      contentFit="contain"
      tintColor={color}
      onError={() => setFailed(true)}
      accessibilityLabel={`${code}, ${rarity}`}
      accessible
    />
  );
  if (!text) return symbol;
  return (
    <View style={styles.labelled}>
      {symbol}
      <Text style={[type.label, styles.shrink]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cardFrame: {
    width: '100%',
    aspectRatio: CARD_RATIO,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noImage: { textAlign: 'center', padding: 8 },
  tile: { flex: 1, gap: 6 },
  tileText: { gap: 1, paddingHorizontal: 2 },
  tileName: { fontFamily: fonts.body, color: colors.text, fontSize: 14, fontWeight: '500' },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  symbols: { flexDirection: 'row', gap: 2, alignItems: 'center' },
  setCode: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700' },
  labelled: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  shrink: { flexShrink: 1 },
});
