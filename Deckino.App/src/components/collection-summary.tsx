import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { cardCount, useCollectionPrices } from '@/api/binders';
import { countCards } from '@/api/decks';
import { useWishlist, wishlistValue } from '@/api/wishlist';
import { formatPrice } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { signedPrice } from '@/components/price-mover';
import { ListRow, Skeleton } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

/**
 * What the binders are worth and this week's change, on Home (opens Collection) and Collection. `empty` (no cards
 * yet, on Home) asks for the first scan in the same space instead.
 */
export function CollectionValue({ onPress, empty }: { onPress?: () => void; empty?: boolean }) {
  const { currency } = usePreferences();
  const prices = useCollectionPrices(currency);
  const failed = !empty && prices.isError && !prices.data;
  return (
    <Pressable
      onPress={failed ? () => void prices.refetch() : onPress}
      disabled={!failed && !onPress}
      accessibilityRole={failed || onPress ? 'button' : undefined}
      style={({ pressed }) => [styles.panel, pressed && styles.pressed]}
    >
      <View style={styles.panelText}>
        <Text style={type.label}>Collection value</Text>
        {empty ? (
          <Text style={[type.body, { color: colors.textMuted }]}>{"Scan your first cards to see what they're worth."}</Text>
        ) : prices.data ? (
          <View style={styles.valueRow}>
            <Text style={styles.value}>{formatPrice(prices.data.value, currency)}</Text>
            {prices.data.weekChange !== 0 ? (
              <Text style={[type.label, { color: prices.data.weekChange > 0 ? colors.success : colors.danger }]}>
                {signedPrice(prices.data.weekChange, currency)} this week
              </Text>
            ) : null}
          </View>
        ) : failed ? (
          <Text style={[type.label, { color: colors.danger }]}>Couldn't load the value. Tap to try again.</Text>
        ) : (
          <Skeleton style={{ height: 36, width: 160 }} />
        )}
      </View>
      {empty ? (
        <View style={styles.icon}>
          <Icon name="document_scanner" size={22} tintColor={colors.lavender} />
        </View>
      ) : onPress && !failed ? (
        <Icon name="chevron_right" size={18} tintColor={colors.textDim} />
      ) : null}
    </Pressable>
  );
}

/** The wishlist's row: how many cards and what they'd cost. */
export function WishlistRow() {
  const router = useRouter();
  const { currency } = usePreferences();
  const wishlist = useWishlist();
  return (
    <ListRow
      leading={
        <View style={styles.icon}>
          <Icon name="favorite" size={22} tintColor={colors.lavender} />
        </View>
      }
      title="Wishlist"
      detail={
        wishlist.data?.length
          ? `${cardCount(countCards(wishlist.data))} · ${formatPrice(wishlistValue(wishlist.data, currency), currency)}`
          : 'The cards you want'
      }
      trailing={<Icon name="chevron_right" size={18} tintColor={colors.textDim} />}
      onPress={() => router.push('/wishlist')}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  panelText: { flex: 1, gap: 4 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 12 },
  value: { fontFamily: fonts.heading, fontSize: 32, fontWeight: '800', color: colors.text },
  icon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
  },
});
