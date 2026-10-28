import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { usePrintings, type Printing } from '@/api/cards';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { finishPick } from '@/components/printing-picker';
import { ErrorState, Skeleton } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

const COLUMNS = 3;

type Item = { key: string; title: string } | { key: string; cells: (Printing | null)[] };

// Every printing of a card as a grid, newest first; the ones with the same picture as `id` first, since a scan can't
// tell those apart. Opened by PrintingButton, which gets the tapped printing.
export default function PrintingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { currency } = usePreferences();
  const printings = usePrintings(id);

  if (printings.isPending) {
    return (
      <View style={[styles.screen, styles.grid]}>
        <View style={styles.row}>
          {Array.from({ length: COLUMNS }, (_, column) => (
            <Skeleton key={column} style={styles.skeleton} />
          ))}
        </View>
      </View>
    );
  }
  if (printings.isError && !printings.data) {
    return (
      <View style={styles.screen}>
        <ErrorState message={printings.error.message} onRetry={() => void printings.refetch()} />
      </View>
    );
  }

  const art = printings.data.find((p) => p.id === id)?.illustrationIds ?? [];
  const same = printings.data.filter((p) => p.illustrationIds.some((i) => art.includes(i)));
  const items: Item[] =
    same.length > 1 && same.length < printings.data.length
      ? [
          { key: 'same', title: 'Same picture' },
          ...rows(same),
          { key: 'other', title: 'Other pictures' },
          ...rows(printings.data.filter((p) => !same.includes(p))),
        ]
      : rows(printings.data);

  return (
    <FlatList
      style={styles.screen}
      data={items}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.grid}
      renderItem={({ item }) =>
        'title' in item ? (
          <Text style={[type.label, styles.title]} accessibilityRole="header">
            {item.title}
          </Text>
        ) : (
          <View style={styles.row}>
            {item.cells.map((printing, index) => {
              if (!printing) return <View key={index} style={styles.cell} />; // keeps the last row's pictures the same size
              const selected = printing.id === id;
              const price = currency === 'eur' ? printing.eur : printing.usd;
              const detail = `${printing.setCode.toUpperCase()} #${printing.collectorNumber}`;
              const number = `#${printing.collectorNumber}`;
              return (
                <Pressable
                  key={printing.id}
                  onPress={() => {
                    router.back();
                    finishPick(printing);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${printing.setName}, ${detail}${price === null ? '' : `, ${formatPrice(price, currency)}`}`}
                  style={({ pressed }) => [styles.cell, styles.printing, selected && styles.selected, pressed && styles.pressed]}
                >
                  <CardImage uri={printing.image} name={printing.setName} />
                  <Text style={styles.setName} numberOfLines={2}>
                    {printing.setName}
                  </Text>
                  {/* The symbol and number: the set's name is just above. */}
                  <View style={styles.detail}>
                    <SetSymbol setCode={printing.setCode} rarity={printing.rarity} size={22} />
                    <Text style={[type.caption, styles.shrink]} numberOfLines={1}>
                      {price === null ? number : `${number} · ${formatPrice(price, currency)}`}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )
      }
    />
  );
}

function rows(printings: Printing[]): Item[] {
  const items: Item[] = [];
  for (let start = 0; start < printings.length; start += COLUMNS) {
    const cells: (Printing | null)[] = printings.slice(start, start + COLUMNS);
    while (cells.length < COLUMNS) cells.push(null);
    items.push({ key: printings[start].id, cells });
  }
  return items;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  grid: { padding: 12, paddingBottom: 32, gap: 8 },
  title: { paddingHorizontal: 4, paddingTop: 8 },
  row: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1 },
  printing: { gap: 4, padding: 4, borderRadius: radius.md, borderWidth: 2, borderColor: 'transparent' },
  selected: { borderColor: colors.violet },
  pressed: { opacity: 0.7 },
  setName: { fontFamily: fonts.body, fontSize: 13, fontWeight: '500', color: colors.text },
  detail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  skeleton: { flex: 1, aspectRatio: 63 / 88 },
});
