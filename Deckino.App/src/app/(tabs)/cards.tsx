import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { noFilters, useCardSearch, type CardFilters } from '@/api/cards';
import { CardTile } from '@/components/card-visuals';
import { Button, Chip, EmptyState, ErrorState, Screen, SearchBox, Skeleton } from '@/components/ui';
import { colors, fonts, radius, type } from '@/theme';

const colorOptions = [
  ['W', 'White'],
  ['U', 'Blue'],
  ['B', 'Black'],
  ['R', 'Red'],
  ['G', 'Green'],
  ['C', 'Colorless'],
] as const;
const manaValues = ['0', '1', '2', '3', '4', '5', '6', '7'];
const rarities = [
  ['common', 'Common'],
  ['uncommon', 'Uncommon'],
  ['rare', 'Rare'],
  ['mythic', 'Mythic'],
] as const;
const sorts = [
  ['name', 'Best match'],
  ['price', 'Most valuable'],
  ['mv', 'Mana value'],
  ['newest', 'Newest'],
] as const;

type Section = 'colors' | 'mv' | 'rarity' | 'type' | 'sort';

export default function CardsScreen() {
  const router = useRouter();
  const [filters, setFilters] = useState<CardFilters>(noFilters);
  const [name, setName] = useState('');
  const [sheet, setSheet] = useState<Section | null>(null);
  const search = useCardSearch(filters);
  const cards = search.data?.pages.flatMap((page) => page.cards) ?? [];

  // The name searches after a pause in typing (or at once on Enter), as on the website.
  useEffect(() => {
    const wait = setTimeout(() => change('q', name.trim()), 350);
    return () => clearTimeout(wait);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  function change(key: keyof CardFilters, value: string) {
    // A new name search sorts by best match again.
    setFilters((current) =>
      current[key] === value ? current : { ...current, [key]: value, ...(key === 'q' ? { sort: '' } : {}) },
    );
  }

  const sortLabel = filters.sort ? sortName(filters.sort, filters.q) : undefined;
  const chips: [Section, string, boolean][] = [
    ['colors', filters.colors ? `Colors: ${filters.colors}` : 'Colors', filters.colors !== ''],
    ['mv', filters.mv ? `Mana value: ${filters.mv === '7' ? '7+' : filters.mv}` : 'Mana value', filters.mv !== ''],
    ['rarity', filters.rarity ? capitalize(filters.rarity) : 'Rarity', filters.rarity !== ''],
    ['type', filters.type ? `Type: ${filters.type}` : 'Type', filters.type !== ''],
    ['sort', sortLabel ?? 'Sort', filters.sort !== ''],
  ];

  return (
    <Screen title="Cards">
      <SearchBox
        value={name}
        onChangeText={setName}
        onSubmit={() => change('q', name.trim())}
        placeholder="Search every Magic card"
        label="Card name"
        style={{ marginHorizontal: 16 }}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        keyboardShouldPersistTaps="handled"
        style={styles.chipsScroll}
      >
        {chips.map(([section, label, selected]) => (
          <Chip key={section} label={label} selected={selected} onPress={() => setSheet(section)} />
        ))}
      </ScrollView>

      {search.isPending ? (
        <View style={styles.grid}>
          {[0, 1, 2, 3].map((row) => (
            <View key={row} style={styles.row}>
              <Skeleton style={styles.skeletonTile} />
              <Skeleton style={styles.skeletonTile} />
            </View>
          ))}
        </View>
      ) : search.isError && cards.length === 0 ? (
        <ErrorState message={search.error.message} onRetry={() => void search.refetch()} />
      ) : (
        <FlatList
          data={cards}
          keyExtractor={(card) => card.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          accessibilityLabel="Search results"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <CardTile
              card={item}
              onPress={() => {
                Keyboard.dismiss();
                router.push(`/card/${item.id}`);
              }}
            />
          )}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            if (search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
          }}
          ListEmptyComponent={
            <EmptyState
              icon={{ ios: 'magnifyingglass', android: 'search_off' }}
              title="No cards match"
              body="Check the spelling, or loosen a filter."
            />
          }
          ListFooterComponent={
            search.isFetchingNextPage ? <ActivityIndicator color={colors.lavender} style={styles.more} /> : null
          }
        />
      )}

      <FilterSheet
        section={sheet}
        filters={filters}
        onChange={change}
        onClose={() => setSheet(null)}
      />
    </Screen>
  );
}

function FilterSheet({
  section,
  filters,
  onChange,
  onClose,
}: {
  section: Section | null;
  filters: CardFilters;
  onChange: (key: keyof CardFilters, value: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState(filters.type);
  const pick = (key: keyof CardFilters, value: string) => onChange(key, filters[key] === value ? '' : value);
  const title = { colors: 'Colors', mv: 'Mana value', rarity: 'Rarity', type: 'Type', sort: 'Sort by' };

  return (
    <Modal visible={section !== null} transparent animationType="slide" onRequestClose={onClose} onShow={() => setTyped(filters.type)}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close filters" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.handle} />
        {section ? <Text style={type.heading}>{title[section]}</Text> : null}
        <View style={styles.options}>
          {section === 'colors' &&
            colorOptions.map(([code, label]) => (
              <Chip
                key={code}
                accessibilityLabel={label}
                selected={filters.colors.includes(code)}
                onPress={() =>
                  onChange(
                    'colors',
                    filters.colors.includes(code) ? filters.colors.replace(code, '') : filters.colors + code,
                  )
                }
                label={
                  <>
                    <Image
                      source={{ uri: `https://svgs.scryfall.io/card-symbols/${code}.svg` }}
                      style={styles.manaSymbol}
                    />
                    <Text style={styles.optionLabel}>{label}</Text>
                  </>
                }
              />
            ))}
          {section === 'mv' &&
            manaValues.map((value) => (
              <Chip key={value} label={value === '7' ? '7+' : value} selected={filters.mv === value} onPress={() => pick('mv', value)} />
            ))}
          {section === 'rarity' &&
            rarities.map(([value, label]) => (
              <Chip key={value} label={label} selected={filters.rarity === value} onPress={() => pick('rarity', value)} />
            ))}
          {section === 'sort' &&
            sorts.map(([value]) => (
              <Chip
                key={value}
                label={sortName(value, filters.q)}
                selected={(filters.sort || (filters.q ? 'name' : 'price')) === value}
                onPress={() => onChange('sort', value)}
              />
            ))}
        </View>
        {section === 'type' ? (
          <TextInput
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={() => {
              onChange('type', typed.trim());
              onClose();
            }}
            placeholder="Creature, Instant, Dragon…"
            placeholderTextColor={colors.textDim}
            accessibilityLabel="Type"
            autoFocus
            returnKeyType="done"
            style={[styles.searchBox, styles.searchInput, styles.typeInput]}
          />
        ) : null}
        <Button
          label="Done"
          onPress={() => {
            if (section === 'type') onChange('type', typed.trim());
            onClose();
          }}
        />
      </View>
    </Modal>
  );
}

// Sorting by name is relevance with a search and A–Z without one.
const sortName = (sort: string, q: string) =>
  sort === 'name' && !q ? 'Name' : (sorts.find(([value]) => value === sort)?.[1] ?? sort);
const capitalize =(value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const styles = StyleSheet.create({
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.text, paddingVertical: 12 },
  chipsScroll: { flexGrow: 0, flexShrink: 0 }, // a ScrollView shrinks by default: the grid below would squeeze it
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  grid: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32, gap: 16 },
  row: { gap: 12 },
  skeletonTile: { flex: 1, aspectRatio: 63 / 88 },
  more: { marginVertical: 16 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.55)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: 24,
    gap: 16,
    borderTopWidth: 1,
    borderColor: colors.glassBorder,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.textDim },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  manaSymbol: { width: 18, height: 18 },
  optionLabel: { fontFamily: fonts.body, color: colors.text, fontSize: 14 },
  typeInput: { marginHorizontal: 0, flex: 0 },
});
