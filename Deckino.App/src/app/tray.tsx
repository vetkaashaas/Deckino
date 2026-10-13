import { useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { copyPrice } from '@/api/binders';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { DefaultsLine } from '@/components/defaults-line';
import { TrayButton } from '@/components/tray-bar';
import { EmptyState } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { clearTray, useTray, valuesOf } from '@/scan/tray';
import { colors, fonts, type } from '@/theme';

// The scanned cards before they're saved: one short row each; tap one to change or remove it.
export default function TrayScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tray = useTray();
  const { currency } = usePreferences();
  // Saved, cleared or the last card removed: back to the scanner (its toast has the undo).
  const had = useRef(tray.length > 0);
  useEffect(() => {
    if (tray.length > 0) had.current = true;
    else if (had.current) router.back();
  }, [tray.length, router]);
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () =>
            tray.length > 0 ? (
              <Pressable onPress={clearTray} accessibilityRole="button" hitSlop={12}>
                <Text style={styles.clear}>Clear</Text>
              </Pressable>
            ) : null,
        }}
      />
      <FlatList
        data={tray}
        keyExtractor={(card) => card.key}
        contentContainerStyle={styles.list}
        ListHeaderComponent={tray.length > 0 ? <DefaultsLine /> : null}
        ListEmptyComponent={
          <EmptyState
            icon={{ ios: 'viewfinder', android: 'document_scanner' }}
            title="Nothing scanned yet"
            body="Cards you scan wait here until you add them to a binder."
            action={{ label: 'Scan cards', onPress: () => router.back() }}
          />
        }
        renderItem={({ item }) => {
          const price = copyPrice(item.printing.prices, valuesOf(item).finish, currency);
          return (
            <Pressable
              onPress={() => router.push({ pathname: '/tray-card', params: { key: item.key } })}
              accessibilityRole="button"
              accessibilityLabel={item.copies > 1 ? `${item.printing.name}, ${item.copies} copies` : undefined}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
            >
              <View style={styles.thumb}>
                <CardImage uri={item.printing.smallImage ?? item.printing.image} name="" />
              </View>
              <View style={styles.flex}>
                <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
                  {item.printing.name}
                </Text>
                <SetSymbol setCode={item.printing.setCode} rarity={item.printing.rarity} size={14} withCode />
              </View>
              <View style={styles.end}>
                <Text style={styles.price}>{formatPrice(price === null ? null : price * item.copies, currency)}</Text>
                {item.copies > 1 ? <Text style={styles.count}>×{item.copies}</Text> : null}
              </View>
            </Pressable>
          );
        }}
      />
      {tray.length > 0 ? (
        <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
          <TrayButton />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: 20, paddingBottom: 120, gap: 6 },
  clear: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.lavender },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  thumb: { width: 44 },
  flex: { flex: 1 },
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
});
