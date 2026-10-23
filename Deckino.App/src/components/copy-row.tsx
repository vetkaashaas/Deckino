import { Pressable, StyleSheet, Text, View } from 'react-native';

import { copyPrice, type CardGroup } from '@/api/binders';
import { finishLabel } from '@/components/card-sheet';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { CONDITIONS, LANGUAGES } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

/** One kind of card in a binder (Lightning Bolt ×4), on the owner's binder screen and a public binder. */
export function GroupRow({
  group,
  count = group.copies.length,
  currency,
  selected = null,
  onPress,
  onLongPress,
}: {
  group: CardGroup;
  /** A public binder's copies come counted, not one by one. */
  count?: number;
  currency: 'usd' | 'eur';
  selected?: boolean | null; // null: not selecting
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const copy = group.copies[0];
  const price = copyPrice(copy.card.prices, copy.finish, currency);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={selected === null ? 'button' : 'checkbox'}
      accessibilityState={selected === null ? undefined : { checked: selected }}
      accessibilityLabel={count > 1 ? `${copy.card.name}, ${count} copies` : undefined}
      style={({ pressed }) => [styles.card, selected && styles.cardSelected, pressed && { opacity: 0.85 }]}
    >
      {selected !== null ? (
        <Icon
          name={
            selected
              ? 'check_circle'
              : 'radio_button_unchecked'
          }
          size={22}
          tintColor={selected ? colors.violet : colors.textDim}
        />
      ) : null}
      <View style={styles.thumb}>
        <CardImage uri={copy.card.smallImage ?? copy.card.image} name="" />
      </View>
      <View style={styles.flex}>
        <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
          {copy.card.name}
        </Text>
        <SetSymbol setCode={copy.card.setCode} rarity={copy.card.rarity} size={14} withCode detail={describe(copy)} />
        {!copy.printingConfirmed ? <Text style={styles.check}>Might be a different printing</Text> : null}
      </View>
      <View style={styles.end}>
        <Text style={styles.price}>{formatPrice(price === null ? null : price * count, currency)}</Text>
        {count > 1 ? <Text style={styles.count}>×{count}</Text> : null}
      </View>
    </Pressable>
  );
}

/** "Lightly Played · Foil · German": only what differs from a plain English near-mint card. */
function describe(copy: CardGroup['copies'][number]) {
  return [
    copy.condition === 'NM' ? null : CONDITIONS.find((c) => c.value === copy.condition)?.label,
    copy.finish === 'nonfoil' ? null : finishLabel(copy.finish),
    copy.language === 'en' ? null : LANGUAGES.find((l) => l.value === copy.language)?.label,
  ]
    .filter(Boolean)
    .join(' · ');
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  cardSelected: { borderColor: colors.violet, backgroundColor: 'rgba(176, 89, 255, 0.10)' },
  thumb: { width: 44 },
  flex: { flex: 1 },
  check: { fontFamily: fonts.body, fontSize: 12, color: colors.warning },
  end: { alignItems: 'flex-end', gap: 2 },
  price: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.text },
  count: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender },
});
