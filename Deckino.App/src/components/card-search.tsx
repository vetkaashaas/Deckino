import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { finishFor, type Finish } from '@/api/binders';
import { getJson } from '@/api/client';
import { noFilters, useCardSearch, type CardDetail, type CardSummary } from '@/api/cards';
import { CardImage, formatPrice } from '@/components/card-visuals';
import { DefaultsLine } from '@/components/defaults-line';
import { attempt } from '@/components/toast';
import { ListRow } from '@/components/ui';
import { getPreferences, usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

/**
 * Add by name, for a binder or a deck: type, tap a card, it's in (the caller's toast has the undo). Tap again for
 * another copy. `onAdd` gets the finish to use: the preferred one when the printing comes in it.
 */
export function CardSearch({
  onAdd,
  defaults = 'all',
}: {
  onAdd: (card: CardSummary, finish: Finish) => Promise<unknown>;
  /** What the "Adding as …" line says: a binder's condition, language and finish, a deck's finish, or nothing. */
  defaults?: 'all' | 'finish' | 'none';
}) {
  const { currency } = usePreferences();
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    const wait = setTimeout(() => setName(typed.trim()), 350);
    return () => clearTimeout(wait);
  }, [typed]);
  const search = useCardSearch({ ...noFilters, q: name }, name.length >= 2);
  const cards = search.data?.pages.flatMap((page) => page.cards) ?? [];

  async function add(card: CardSummary) {
    await attempt(async () => {
      // The printing's finishes decide whether the preferred one is possible, as the website's quick add.
      const detail = await getJson<CardDetail>(`/api/cards/${card.id}`);
      await onAdd(card, finishFor(detail.finishes, getPreferences().finish));
    });
  }

  return (
    <FlatList
      data={cards}
      keyExtractor={(card) => card.id}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      onEndReached={() => search.hasNextPage && !search.isFetchingNextPage && void search.fetchNextPage()}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.searchBox}>
            <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={18} tintColor={colors.textDim} />
            <TextInput
              value={typed}
              onChangeText={setTyped}
              onSubmitEditing={() => setName(typed.trim())}
              placeholder="Card name"
              placeholderTextColor={colors.textDim}
              selectionColor={colors.lavender}
              accessibilityLabel="Card name"
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
              style={styles.input}
            />
          </View>
          {defaults === 'none' ? null : <DefaultsLine finishOnly={defaults === 'finish'} />}
        </View>
      }
      ListEmptyComponent={
        name.length >= 2 && search.isSuccess ? (
          <Text style={[type.body, styles.none]}>No card called “{name}”.</Text>
        ) : search.isError ? (
          <Text style={[type.body, styles.none]}>{search.error.message}</Text>
        ) : null
      }
      renderItem={({ item }) => (
        <ListRow
          leading={
            <View style={styles.thumb}>
              <CardImage uri={item.smallImage ?? item.image} name="" />
            </View>
          }
          title={item.name}
          detail={`${item.setName} · ${formatPrice(item[currency], currency)}`}
          trailing={<SymbolView name={{ ios: 'plus.circle.fill', android: 'add_circle' }} size={28} tintColor={colors.pink} />}
          onPress={() => void add(item)}
          accessibilityLabel={`Add ${item.name}, ${item.setName}`}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 140 },
  header: { gap: 8, marginBottom: 8 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  input: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.text, paddingVertical: 10 },
  thumb: { width: 40 },
  none: { color: colors.textMuted, textAlign: 'center', paddingVertical: 24 },
});
