import { useEffect, useMemo } from 'react';
import { FlatList, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccount } from '@/api/account';
import { cardCount, copyPrice, publicBinderUrl, useBinders, usePublicBinder, type PublicBinder } from '@/api/binders';
import { ApiError } from '@/api/client';
import { formatPrice } from '@/components/card-visuals';
import { GroupRow } from '@/components/copy-row';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { ambient, colors, type } from '@/theme';

// Someone's public binder, from a deckino.com/binder link (AppPlan, Phase A8): what's in it and what it's worth.
// The owner is sent on to their own binder screen.
export default function PublicBinderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { currency } = usePreferences();
  const found = usePublicBinder(id);
  const account = useAccount();
  const username = account.data?.username;
  // Theirs even when it's private now (a 404 here, so only then): their own binder list has it.
  const gone = found.error instanceof ApiError && found.error.status === 404;
  const mineQuery = useBinders(currency, gone);
  const mine = mineQuery.data;
  const own = (found.data !== undefined && found.data.owner === username) || (mine?.some((b) => b.id === id) ?? false);
  useEffect(() => {
    if (own) router.replace(`/binder/${id}`);
  }, [own, id, router]);

  const binder = found.data;
  const rows = useMemo(() => (binder ? groups(binder.cards) : []), [binder]);
  const count = binder?.cards.reduce((sum, c) => sum + c.count, 0) ?? 0;
  const value = binder?.cards.reduce((sum, c) => sum + (copyPrice(c.card.prices, c.finish, currency) ?? 0) * c.count, 0) ?? 0;

  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <Stack.Screen
        options={{
          title: binder?.name ?? '',
          headerRight: () =>
            binder ? (
              <Pressable
                onPress={() => void Share.share({ message: publicBinderUrl(id) })}
                accessibilityRole="button"
                accessibilityLabel="Share link"
                hitSlop={12}
              >
                <SymbolView name={{ ios: 'square.and.arrow.up', android: 'share' }} size={22} tintColor={colors.text} />
              </Pressable>
            ) : null,
        }}
      />
      {found.isPending || own || mineQuery.isLoading || account.isLoading ? (
        <View style={styles.list}>
          <Skeleton style={{ height: 20, width: '50%' }} />
          <Skeleton style={{ height: 64 }} />
          <Skeleton style={{ height: 64 }} />
        </View>
      ) : found.isError && !found.data ? (
        found.error instanceof ApiError && found.error.status === 404 ? (
          <EmptyState
            icon={{ ios: 'eye.slash', android: 'visibility_off' }}
            title="Binder not found"
            body="There's no public binder here. Its owner may have made it private."
          />
        ) : (
          <ErrorState message={found.error.message} onRetry={() => void found.refetch()} />
        )
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.group.key}
          contentContainerStyle={[styles.list, { paddingBottom: 40 + insets.bottom }]}
          ListHeaderComponent={
            <Text style={[type.label, styles.header]}>
              by {found.data.owner} · {cardCount(count)} · {formatPrice(value, currency)}
              {found.data.isSelling ? ' · For sale' : ''}
            </Text>
          }
          ListEmptyComponent={
            <EmptyState icon={{ ios: 'rectangle.stack', android: 'playing_cards' }} title="Nothing in here yet" body="This binder is empty." />
          }
          renderItem={({ item: { group, count } }) => (
            <GroupRow group={group} count={count} currency={currency} onPress={() => router.push(`/card/${group.copies[0].scryfallId}`)} />
          )}
        />
      )}
    </View>
  );
}

// The public cards come counted; one copy and the count make the binder screen's row (no notes or check to show).
const groups = (cards: PublicBinder['cards']) =>
  cards.map((c) => ({
    count: c.count,
    group: { key: `${c.scryfallId}-${c.finish}-${c.condition}-${c.language}`, copies: [{ ...c, id: '', notes: null, printingConfirmed: true }] },
  }));

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  list: { padding: 20, gap: 8 },
  header: { marginBottom: 4 },
});
