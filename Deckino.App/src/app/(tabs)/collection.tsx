import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { useBinders, useCollectionPrices, type BinderSummary, type PriceMover } from '@/api/binders';
import { useSignedIn } from '@/api/session';
import { CardImage, formatPrice } from '@/components/card-visuals';
import { Button, EmptyState, ErrorState, ListRow, Screen, Skeleton } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// The collection's value, the binders, and this week's biggest price moves (AppPlan, Phase A4).
export default function CollectionScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  if (!signedIn) {
    return (
      <Screen title="Collection">
        <EmptyState
          icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
          title="Your binders, in your pocket"
          body="Sign in to sort your cards into binders and see what they're worth."
          action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
        />
      </Screen>
    );
  }
  return (
    <Screen title="Collection">
      <Binders />
    </Screen>
  );
}

function Binders() {
  const router = useRouter();
  const { currency } = usePreferences();
  const binders = useBinders(currency);
  const prices = useCollectionPrices(currency);

  if (binders.isPending) {
    return (
      <View style={styles.content}>
        <Skeleton style={{ height: 96, borderRadius: radius.lg }} />
        <Skeleton style={{ height: 56 }} />
        <Skeleton style={{ height: 56 }} />
      </View>
    );
  }
  if (binders.isError) return <ErrorState message={binders.error.message} onRetry={() => void binders.refetch()} />;
  if (binders.data.length === 0) {
    return (
      <EmptyState
        icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
        title="Make your first binder"
        body="A binder holds your cards: one for trades, one per box, whatever suits you."
        action={{ label: 'New binder', onPress: () => router.push('/binder/new') }}
      />
    );
  }

  const movers = prices.data?.movers.slice(0, 5) ?? [];
  return (
    <FlatList
      data={binders.data}
      keyExtractor={(binder) => binder.id}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={binders.isRefetching}
          onRefresh={() => void Promise.all([binders.refetch(), prices.refetch()])}
          tintColor={colors.lavender}
          colors={[colors.purple]}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.panel}>
            <Text style={type.label}>Collection value</Text>
            {prices.data ? (
              <>
                <Text style={styles.value}>{formatPrice(prices.data.value, currency)}</Text>
                {prices.data.weekChange !== 0 ? (
                  <Text style={[type.label, { color: prices.data.weekChange > 0 ? colors.success : colors.danger }]}>
                    {signed(prices.data.weekChange, currency)} this week
                  </Text>
                ) : null}
              </>
            ) : (
              <Skeleton style={{ height: 32, width: 120 }} />
            )}
          </View>
          <Button label="New binder" variant="secondary" icon={{ ios: 'plus', android: 'add' }} onPress={() => router.push('/binder/new')} />
        </View>
      }
      renderItem={({ item }) => <BinderRow binder={item} currency={currency} />}
      ListFooterComponent={
        movers.length > 0 ? (
          <View style={styles.movers}>
            <Text style={type.heading}>Biggest moves this week</Text>
            {movers.map((mover) => (
              <MoverRow key={`${mover.card.id}-${mover.finish}`} mover={mover} currency={currency} />
            ))}
          </View>
        ) : null
      }
    />
  );
}

function BinderRow({ binder, currency }: { binder: BinderSummary; currency: 'usd' | 'eur' }) {
  const router = useRouter();
  const cards = `${binder.cardCount} ${binder.cardCount === 1 ? 'card' : 'cards'}`;
  return (
    <ListRow
      leading={
        <View style={styles.art}>
          {binder.cover ? (
            <Image source={{ uri: binder.cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <SymbolView name={{ ios: 'books.vertical', android: 'collections_bookmark' }} size={22} tintColor={colors.lavender} />
          )}
        </View>
      }
      title={binder.name}
      detail={binder.cardCount > 0 ? `${cards} · ${formatPrice(binder.value, currency)}` : 'Empty'}
      trailing={<SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={18} tintColor={colors.textDim} />}
      onPress={() => router.push(`/binder/${binder.id}`)}
    />
  );
}

function MoverRow({ mover, currency }: { mover: PriceMover; currency: 'usd' | 'eur' }) {
  const router = useRouter();
  return (
    <ListRow
      leading={
        <View style={styles.cover}>
          <CardImage uri={mover.card.smallImage ?? mover.card.image} name="" />
        </View>
      }
      title={mover.card.name}
      detail={mover.card.setName}
      trailing={
        <Text style={[styles.change, { color: mover.change > 0 ? colors.success : colors.danger }]}>
          {signed(mover.change, currency)}
        </Text>
      }
      onPress={() => router.push(`/card/${mover.card.id}`)}
    />
  );
}

const signed = (amount: number, currency: 'usd' | 'eur') =>
  `${amount > 0 ? '+' : '−'}${formatPrice(Math.abs(amount), currency)}`;

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 140, gap: 4 },
  header: { gap: 12, marginBottom: 8 },
  panel: {
    gap: 4,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  value: { fontFamily: fonts.heading, fontSize: 30, fontWeight: '800', color: colors.text },
  cover: {
    width: 40,
    aspectRatio: 63 / 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
    overflow: 'hidden',
  },
  art: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
    overflow: 'hidden',
  },
  movers: { gap: 4, marginTop: 24 },
  change: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600' },
});
