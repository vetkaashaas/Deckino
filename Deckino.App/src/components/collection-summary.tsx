import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { cardCount, useBinders, useCollectionPrices } from '@/api/binders';
import { countCards } from '@/api/decks';
import { useWishlist, wishlistValue } from '@/api/wishlist';
import { formatPrice } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { signedPrice } from '@/components/price-mover';
import { ListRow, Skeleton } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

/** What the binders are worth and this week's change, on Home (opens Collection) and Collection. */
/** `line`: a brand line under it, where nothing below draws one of its own (Home; Collection's tabs have theirs). */
export function CollectionValue({ onPress, line }: { onPress?: () => void; line?: boolean }) {
  const { currency } = usePreferences();
  const prices = useCollectionPrices(currency);
  const binders = useBinders(currency);
  const failed = prices.isError && !prices.data;
  const cards = binders.data?.reduce((sum, binder) => sum + binder.cardCount, 0);
  const change = prices.data?.weekChange ?? 0;
  const up = change > 0;
  // Against last week's value; an approximation, as only cards with a price on both days count in the change.
  const before = (prices.data?.value ?? 0) - change;
  const percent = before > 0 ? Math.abs(change / before) * 100 : null;
  return (
    <Pressable
      onPress={failed ? () => void prices.refetch() : onPress}
      disabled={!failed && !onPress}
      accessibilityRole={failed || onPress ? 'button' : undefined}
      style={({ pressed }) => [styles.panel, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <Text style={type.label}>
          Collection value{cards !== undefined && cards > 0 ? ` · ${cardCount(cards)}` : ''}
        </Text>
        {onPress && !failed ? <Icon name="chevron_right" size={16} tintColor={colors.textDim} /> : null}
      </View>
      {prices.data ? (
        <>
          <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
            {formatPrice(prices.data.value, currency)}
          </Text>
          {change !== 0 ? (
            <View style={styles.changeRow}>
              <View style={[styles.pill, up ? styles.pillUp : styles.pillDown]}>
                <Icon name={up ? 'trending_up' : 'trending_down'} size={16} tintColor={up ? colors.success : colors.danger} />
                <Text style={[styles.pillLabel, { color: up ? colors.success : colors.danger }]}>
                  {signedPrice(change, currency)}
                  {percent !== null ? ` · ${percent.toFixed(1)}%` : ''}
                </Text>
              </View>
              <Text style={type.label}>this week</Text>
            </View>
          ) : (
            <Text style={type.label}>No change this week</Text>
          )}
        </>
      ) : failed ? (
        <Text style={[type.label, { color: colors.danger }]}>{"Couldn't load the value. Tap to try again."}</Text>
      ) : (
        <>
          <Skeleton style={{ height: 44, width: 180 }} />
          <Skeleton style={{ height: 26, width: 140, borderRadius: radius.pill }} />
        </>
      )}
      {line ? <View style={styles.line} /> : null}
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
  // No box (a box with a glow read as a credit card): the value is the page's headline, with a soft shine, and on Home a
  // brand line under it that fades out.
  panel: { gap: 6, paddingTop: 4 },
  pressed: { opacity: 0.7 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  value: {
    fontFamily: fonts.heading,
    fontSize: 46,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.5,
    lineHeight: 52,
    textShadowColor: 'rgba(176, 89, 255, 0.55)',
    textShadowRadius: 18,
  },
  line: {
    height: 2,
    marginTop: 10,
    borderRadius: 1,
    experimental_backgroundImage: `linear-gradient(90deg, ${colors.violet} 0%, rgba(121, 17, 203, 0.5) 35%, rgba(121, 17, 203, 0) 100%)`,
  },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  pillUp: { backgroundColor: 'rgba(91, 227, 161, 0.14)' },
  pillDown: { backgroundColor: 'rgba(255, 90, 122, 0.14)' },
  pillLabel: { fontFamily: fonts.body, fontSize: 13, fontWeight: '600' },
  icon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
  },
});
