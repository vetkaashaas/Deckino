import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
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
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { defaultSort, noFilters, useCardSearch, type CardFilters, type CardSummary } from '@/api/cards';
import { CardTile, ManaCost } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { Button, Chip, EmptyState, ErrorState, Screen, SearchBox, Skeleton } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
import { ambient, colors, fonts, radius, type } from '@/theme';

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
// One tap for the card types; the field below them takes anything else (Dragon, Equipment…).
const types = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land'];
const sorts = [
  ['name', 'Best match'],
  ['price', 'Most valuable'],
  ['mv', 'Mana value'],
  ['newest', 'Newest'],
] as const;

type Section = 'colors' | 'mv' | 'rarity' | 'type' | 'sort';

// The grid button steps through 2, 3 and 4 cards across; its icon shows the current one.
const gridIcons = {
  2: 'grid_view',
  3: 'view_module',
  4: 'background_grid_small',
} as const;
const FADE = 16; // the grid fades out under the title (Android) and starts this far below the filters

export default function CardsScreen() {
  const router = useRouter();
  const [filters, setFilters] = useState<CardFilters>(noFilters);
  const [name, setName] = useState('');
  const [sheet, setSheet] = useState<Section | null>(null);
  const search = useCardSearch(filters);
  const { cardColumns: columns } = usePreferences();
  const cards = search.data?.pages.flatMap((page) => page.cards) ?? [];
  // Empty cells fill the last row, so its tiles are as wide as the rest.
  const cells: (CardSummary | null)[] = [
    ...cards,
    ...Array<null>((columns - (cards.length % columns)) % columns).fill(null),
  ];

  // The search and filters float over the grid. Near the top they scroll with the cards; further down they slide
  // away with them and come back on any scroll up, never left half-way. A screen reader keeps them in place.
  const [headerHeight, setHeaderHeight] = useState(0);
  const [area, setArea] = useState({ y: 0, height: 0 }); // where the grid sits on the page, to line up the glow
  const [screenReader, setScreenReader] = useState(false);
  const header = useSharedValue(0);
  const hidden = useSharedValue(0); // how far they've slid up
  const scrollY = useSharedValue(0);
  const settle = () => {
    'worklet';
    if (scrollY.value > header.value) {
      hidden.value = withTiming(hidden.value > header.value / 2 ? header.value : 0, { duration: 160 });
    }
  };
  const onScroll = useAnimatedScrollHandler({
    onScroll: ({ contentOffset: { y } }) => {
      hidden.value = Math.min(Math.max(hidden.value + y - scrollY.value, 0), header.value, Math.max(y, 0));
      scrollY.value = y;
    },
    onEndDrag: settle,
    onMomentumEnd: settle,
  });
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: -hidden.value }] }));
  // Their backing shows only once cards pass underneath. It's the page's own glow, held still while they slide.
  const backdrop = useAnimatedStyle(() => ({
    opacity: Math.min(Math.max((scrollY.value - hidden.value) / FADE, 0), 1),
  }));
  const glow = useAnimatedStyle(() => ({ transform: [{ translateY: hidden.value }] }));

  // New results start at the top.
  useEffect(() => {
    scrollY.value = 0;
    hidden.value = 0;
  }, [search.isPending, columns]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => subscription.remove();
  }, []);

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

  // Each button says what it's set to; Sort always does (the default too). Colors shows the mana symbols.
  const colorNames = colorOptions.filter(([code]) => filters.colors.includes(code)).map(([, label]) => label);
  const sortLabel = sortName(filters.sort || defaultSort(filters.q), filters.q);
  const chips: [Section, ReactNode, boolean, string?][] = [
    [
      'colors',
      filters.colors ? <ManaCost cost={[...filters.colors].map((code) => `{${code}}`).join('')} /> : 'Colors',
      filters.colors !== '',
      `Colors${colorNames.length ? `: ${colorNames.join(', ')}` : ''}`,
    ],
    ['mv', filters.mv ? `Mana value: ${filters.mv === '7' ? '7+' : filters.mv}` : 'Mana value', filters.mv !== ''],
    ['rarity', filters.rarity ? capitalize(filters.rarity) : 'Rarity', filters.rarity !== ''],
    ['type', filters.type ? `Type: ${filters.type}` : 'Type', filters.type !== ''],
    ['sort', sortLabel, filters.sort !== '', `Sort: ${sortLabel}`],
  ];
  const filtered = [filters.colors, filters.mv, filters.rarity, filters.type, filters.sort].some(
    (value) => value !== '',
  );

  return (
    <Screen title="Cards">
      <View style={styles.results} onLayout={(event) => setArea(event.nativeEvent.layout)}>
        {search.isPending ? (
          <View style={[styles.grid, { paddingTop: headerHeight + FADE }]}>
            {[0, 1, 2, 3].map((row) => (
              <View key={row} style={styles.row}>
                {Array.from({ length: columns }, (_, column) => (
                  <Skeleton key={column} style={styles.skeletonTile} />
                ))}
              </View>
            ))}
          </View>
        ) : search.isError && cards.length === 0 ? (
          <View style={{ paddingTop: headerHeight }}>
            <ErrorState message={search.error.message} onRetry={() => void search.refetch()} />
          </View>
        ) : (
          <Animated.FlatList
            key={columns} // a FlatList can't change its columns in place
            data={cells}
            keyExtractor={(card, index) => card?.id ?? `empty-${index}`}
            numColumns={columns}
            columnWrapperStyle={styles.row}
            contentContainerStyle={[styles.grid, { paddingTop: headerHeight + FADE }]}
            scrollIndicatorInsets={{ top: headerHeight }}
            onScroll={screenReader ? undefined : onScroll}
            scrollEventThrottle={16}
            fadingEdgeLength={{ start: FADE, end: 0 }}
            accessibilityLabel="Search results"
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) =>
              item ? (
                <CardTile
                  card={item}
                  onPress={() => {
                    Keyboard.dismiss();
                    router.push(`/card/${item.id}`);
                  }}
                />
              ) : (
                <View style={styles.emptyCell} />
              )
            }
            onEndReachedThreshold={0.6}
            onEndReached={() => {
              if (search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
            }}
            ListEmptyComponent={
              <EmptyState
                icon="search_off"
                title="No cards match"
                body="Check the spelling, or loosen a filter."
              />
            }
            ListFooterComponent={
              search.isFetchingNextPage ? <ActivityIndicator color={colors.lavender} style={styles.more} /> : null
            }
          />
        )}
        <Animated.View
          style={[styles.header, slide]}
          onLayout={(event) => {
            setHeaderHeight(event.nativeEvent.layout.height);
            header.value = event.nativeEvent.layout.height;
          }}
        >
          <Animated.View style={[styles.headerBackdrop, backdrop]}>
            <Animated.View style={[styles.glow, { top: -area.y, height: area.y + area.height }, glow]} />
          </Animated.View>
          <View style={styles.searchRow}>
            <SearchBox
              value={name}
              onChangeText={setName}
              onSubmit={() => change('q', name.trim())}
              placeholder="Search every Magic card"
              label="Card name"
              style={styles.flex}
            />
            <Pressable
              onPress={() => setPreferences({ cardColumns: columns === 4 ? 2 : ((columns + 1) as 3 | 4) })}
              accessibilityRole="button"
              accessibilityLabel={`${columns} cards across`}
              accessibilityHint="Shows more or fewer cards in a row"
              style={({ pressed }) => [styles.gridButton, pressed && styles.pressed]}
            >
              <Icon name={gridIcons[columns]} size={22} tintColor={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
            keyboardShouldPersistTaps="handled"
            style={styles.chipsScroll}
          >
            {filtered ? (
              <Chip
                label={
                  <>
                    <Icon name="close" size={16} tintColor={colors.textMuted} />
                    <Text style={styles.clearLabel}>Clear</Text>
                  </>
                }
                selected={false}
                accessibilityLabel="Clear filters"
                onPress={() => setFilters((current) => ({ ...noFilters, q: current.q }))}
              />
            ) : null}
            {chips.map(([section, label, selected, accessibilityLabel]) => (
              <Chip
                key={section}
                label={label}
                selected={selected}
                accessibilityLabel={accessibilityLabel}
                onPress={() => setSheet(section)}
              />
            ))}
          </ScrollView>
        </Animated.View>
      </View>

      <FilterSheet section={sheet} filters={filters} onChange={change} onClose={() => setSheet(null)} />
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
  const title = {
    colors: 'Colors',
    mv: 'Mana value',
    rarity: 'Rarity',
    type: 'Type',
    sort: 'Sort by',
  };

  return (
    <Modal
      visible={section !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => setTyped(filters.type)}
    >
      {/* The sheet rises with the keyboard, so the type field and Done stay in sight. */}
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
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
                        source={{
                          uri: `https://svgs.scryfall.io/card-symbols/${code}.svg`,
                        }}
                        style={styles.manaSymbol}
                      />
                      <Text style={styles.optionLabel}>{label}</Text>
                    </>
                  }
                />
              ))}
            {section === 'mv' &&
              manaValues.map((value) => (
                <Chip
                  key={value}
                  label={value === '7' ? '7+' : value}
                  selected={filters.mv === value}
                  onPress={() => pick('mv', value)}
                />
              ))}
            {section === 'rarity' &&
              rarities.map(([value, label]) => (
                <Chip
                  key={value}
                  label={label}
                  selected={filters.rarity === value}
                  onPress={() => pick('rarity', value)}
                />
              ))}
            {section === 'type' &&
              types.map((value) => (
                <Chip
                  key={value}
                  label={value}
                  selected={typed.trim().toLowerCase() === value.toLowerCase()}
                  onPress={() => {
                    const next = typed.trim().toLowerCase() === value.toLowerCase() ? '' : value;
                    Keyboard.dismiss();
                    setTyped(next);
                    onChange('type', next);
                  }}
                />
              ))}
            {section === 'sort' &&
              sorts.map(([value]) => (
                <Chip
                  key={value}
                  label={sortName(value, filters.q)}
                  selected={(filters.sort || defaultSort(filters.q)) === value}
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
              placeholder="Or any type: Dragon, Equipment…"
              placeholderTextColor={colors.textDim}
              accessibilityLabel="Type"
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
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Sorting by name is relevance with a search and A–Z without one.
const sortName = (sort: string, q: string) =>
  sort === 'name' && !q ? 'Name' : (sorts.find(([value]) => value === sort)?.[1] ?? sort);
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

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
  searchInput: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 12,
  },
  results: { flex: 1, overflow: 'hidden' },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerBackdrop: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
    borderBottomWidth: 1,
    borderColor: colors.glassBorder,
  },
  glow: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    experimental_backgroundImage: ambient,
  },
  searchRow: { flexDirection: 'row', gap: 8, marginHorizontal: 16 },
  gridButton: {
    width: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  chipsScroll: { flexGrow: 0, flexShrink: 0 }, // a ScrollView shrinks by default: the grid below would squeeze it
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  grid: { paddingHorizontal: 16, paddingTop: FADE, paddingBottom: 32, gap: 16 },
  row: { gap: 10 },
  skeletonTile: { flex: 1, aspectRatio: 63 / 88 },
  emptyCell: { flex: 1 },
  more: { marginVertical: 16 },
  flex: { flex: 1 },
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
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textDim,
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  manaSymbol: { width: 18, height: 18 },
  optionLabel: { fontFamily: fonts.body, color: colors.text, fontSize: 14 },
  clearLabel: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 14 },
  typeInput: { marginHorizontal: 0, flex: 0 },
});
