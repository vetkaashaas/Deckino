import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import type { PriceMover } from '@/api/binders';
import { finishLabel } from '@/components/card-sheet';
import { CardImage, formatPrice } from '@/components/card-visuals';
import { ListRow } from '@/components/ui';
import { colors, fonts } from '@/theme';

/** "+$1.20" or "−$0.80". */
export const signedPrice = (amount: number, currency: 'usd' | 'eur') =>
  `${amount > 0 ? '+' : '−'}${formatPrice(Math.abs(amount), currency)}`;

/**
 * One of this week's biggest price moves, with today's price: in your binders by what it changed your value, with how
 * many you have and a foil marked (Collection), or in the market by percent (Home).
 */
export function MoverRow({ mover, currency, market }: { mover: PriceMover; currency: 'usd' | 'eur'; market?: boolean }) {
  const router = useRouter();
  return (
    <ListRow
      leading={
        <View style={styles.cover}>
          <CardImage uri={mover.card.smallImage ?? mover.card.image} name="" />
        </View>
      }
      title={mover.card.name}
      detail={[
        `${!market && mover.count > 1 ? `${mover.count} × ` : ''}${formatPrice(mover.now, currency)}`,
        !market && mover.finish !== 'nonfoil' ? finishLabel(mover.finish) : null,
        mover.card.setName,
      ]
        .filter(Boolean)
        .join(' · ')}
      trailing={
        <Text style={[styles.change, { color: mover.change > 0 ? colors.success : colors.danger }]}>
          {market ? `${mover.percent > 0 ? '+' : '−'}${Math.round(Math.abs(mover.percent))}%` : signedPrice(mover.change, currency)}
        </Text>
      }
      onPress={() => router.push(`/card/${mover.card.id}`)}
    />
  );
}

const styles = StyleSheet.create({
  cover: {
    width: 40,
    aspectRatio: 63 / 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
    overflow: 'hidden',
  },
  change: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600' },
});
