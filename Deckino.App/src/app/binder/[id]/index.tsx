import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  cardCount,
  copyPrice,
  groupCopies,
  removeCards,
  restoreCards,
  useBinder,
  type BinderDetail,
  type CardGroup,
} from '@/api/binders';
import { finishLabel } from '@/components/card-sheet';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { attempt, showToast } from '@/components/toast';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { CONDITIONS, LANGUAGES, setPreferences, usePreferences } from '@/preferences';
import { ambient, colors, fonts, radius, type } from '@/theme';

// A binder: one row per kind of card (Lightning Bolt ×4), and one main action, Add cards (AppPlan, Phase A4).
export default function BinderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const binder = useBinder(id);
  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <Stack.Screen
        options={{
          title: binder.data?.name ?? '',
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/binder/${id}/settings`)}
              accessibilityRole="button"
              accessibilityLabel="Binder settings"
              hitSlop={12}
            >
              <SymbolView name={{ ios: 'gearshape', android: 'settings' }} size={22} tintColor={colors.text} />
            </Pressable>
          ),
        }}
      />
      {binder.isPending ? (
        <View style={styles.list}>
          <Skeleton style={{ height: 20, width: '50%' }} />
          <Skeleton style={{ height: 64 }} />
          <Skeleton style={{ height: 64 }} />
        </View>
      ) : binder.isError ? (
        <ErrorState message={binder.error.message} onRetry={() => void binder.refetch()} />
      ) : (
        <Cards binder={binder.data} />
      )}
    </View>
  );
}

function Cards({ binder }: { binder: BinderDetail }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { currency } = usePreferences();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string> | null>(null); // null: not selecting
  const [adding, setAdding] = useState(false);

  const groups = groupCopies(binder.cards);
  const shown = search.trim()
    ? groups.filter((g) => g.copies[0].card.name.toLowerCase().includes(search.trim().toLowerCase()))
    : groups;
  const value = binder.cards.reduce((sum, c) => sum + (copyPrice(c.card.prices, c.finish, currency) ?? 0), 0);
  const unchecked = binder.cards.filter((c) => !c.printingConfirmed).length;
  const firstUnchecked = groups.find((g) => !g.copies[0].printingConfirmed);
  const chosen = groups.filter((g) => selected?.has(g.key)).flatMap((g) => g.copies);

  const open = (group: CardGroup, check = false) =>
    router.push({ pathname: '/binder/[id]/card', params: { id: binder.id, ids: group.copies.map((c) => c.id).join(','), check: check ? '1' : '' } });
  const toggle = (group: CardGroup) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(group.key)) next.add(group.key);
      return next;
    });

  async function removeChosen() {
    const copies = chosen;
    if (await attempt(() => removeCards(binder.id, copies.map((c) => c.id)))) {
      setSelected(null);
      showToast({ message: `Removed ${cardCount(copies.length)}`, undo: () => void attempt(() => restoreCards(binder.id, copies)) });
    }
  }

  return (
    <>
      <FlatList
        data={shown}
        keyExtractor={(g) => g.key}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={type.label}>
              {cardCount(binder.cards.length)} · {formatPrice(value, currency)}
            </Text>
            {unchecked > 0 && firstUnchecked ? (
              <Pressable
                onPress={() => open(firstUnchecked, true)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.banner, pressed && { opacity: 0.8 }]}
              >
                <SymbolView name={{ ios: 'exclamationmark.circle', android: 'info' }} size={20} tintColor={WARN} />
                <Text style={[type.body, styles.flex]}>
                  {unchecked === 1 ? '1 card might be' : `${unchecked} cards might be`} a different printing
                </Text>
                <Text style={styles.bannerAction}>Check</Text>
              </Pressable>
            ) : null}
            {binder.cards.length > 0 ? (
              <View style={styles.tools}>
                <View style={styles.searchBox}>
                  <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={18} tintColor={colors.textDim} />
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Find a card in this binder"
                    placeholderTextColor={colors.textDim}
                    selectionColor={colors.lavender}
                    accessibilityLabel="Find a card in this binder"
                    style={styles.searchInput}
                  />
                </View>
                <Pressable
                  onPress={() => setSelected(selected ? null : new Set())}
                  accessibilityRole="button"
                  hitSlop={8}
                  style={({ pressed }) => [styles.select, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.selectLabel}>{selected ? 'Done' : 'Select'}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          binder.cards.length === 0 ? (
            <EmptyState
              icon={{ ios: 'rectangle.stack', android: 'playing_cards' }}
              title="Nothing in here yet"
              body="Scan your cards, or find them by name."
            />
          ) : (
            <Text style={[type.body, styles.none]}>No card here matches “{search.trim()}”.</Text>
          )
        }
        renderItem={({ item }) => (
          <GroupRow
            group={item}
            currency={currency}
            selected={selected ? selected.has(item.key) : null}
            onPress={() => (selected ? toggle(item) : open(item))}
            onLongPress={() => {
              setSelected((current) => current ?? new Set());
              toggle(item);
            }}
          />
        )}
      />

      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        {selected ? (
          <View style={styles.row}>
            <Button
              label={chosen.length > 0 ? `Move ${chosen.length}` : 'Move'}
              variant="secondary"
              icon={{ ios: 'arrow.right.square', android: 'drive_file_move' }}
              onPress={() =>
                chosen.length > 0 &&
                router.push({ pathname: '/binder/[id]/move', params: { id: binder.id, ids: chosen.map((c) => c.id).join(',') } })
              }
              style={styles.flex}
            />
            <Button
              label={chosen.length > 0 ? `Remove ${chosen.length}` : 'Remove'}
              variant="secondary"
              icon={{ ios: 'trash', android: 'delete' }}
              onPress={() => chosen.length > 0 && void removeChosen()}
              style={styles.flex}
            />
          </View>
        ) : adding ? (
          <View style={styles.row}>
            <Button
              label="Scan"
              icon={{ ios: 'viewfinder', android: 'document_scanner' }}
              onPress={() => {
                setAdding(false);
                setPreferences({ defaultBinderId: binder.id, scanDeckId: null }); // the scanner's tray saves here
                router.navigate('/scan');
              }}
              style={styles.flex}
            />
            <Button
              label="Search"
              variant="secondary"
              icon={{ ios: 'magnifyingglass', android: 'search' }}
              onPress={() => {
                setAdding(false);
                router.push({ pathname: '/binder/[id]/add', params: { id: binder.id } });
              }}
              style={styles.flex}
            />
          </View>
        ) : (
          <Button label="Add cards" icon={{ ios: 'plus', android: 'add' }} onPress={() => setAdding(true)} />
        )}
      </View>
    </>
  );
}

function GroupRow({
  group,
  currency,
  selected,
  onPress,
  onLongPress,
}: {
  group: CardGroup;
  currency: 'usd' | 'eur';
  selected: boolean | null; // null: not selecting
  onPress: () => void;
  onLongPress: () => void;
}) {
  const copy = group.copies[0];
  const count = group.copies.length;
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
        <SymbolView
          name={
            selected
              ? { ios: 'checkmark.circle.fill', android: 'check_circle' }
              : { ios: 'circle', android: 'radio_button_unchecked' }
          }
          size={22}
          tintColor={selected ? colors.pink : colors.textDim}
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

const WARN = '#F2D27A';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  list: { padding: 20, gap: 8 },
  header: { gap: 12, marginBottom: 4 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: 'rgba(242, 210, 122, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(242, 210, 122, 0.35)',
  },
  bannerAction: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: WARN },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 15, color: colors.text, paddingVertical: 8 },
  select: { paddingHorizontal: 4, paddingVertical: 10 },
  selectLabel: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.lavender },
  none: { color: colors.textMuted, textAlign: 'center', paddingVertical: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  cardSelected: { borderColor: colors.pink, backgroundColor: 'rgba(222, 65, 144, 0.10)' },
  thumb: { width: 44 },
  flex: { flex: 1 },
  check: { fontFamily: fonts.body, fontSize: 12, color: WARN },
  end: { alignItems: 'flex-end', gap: 2 },
  price: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.text },
  count: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: 'rgba(11, 6, 16, 0.94)',
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  row: { flexDirection: 'row', gap: 12 },
});
