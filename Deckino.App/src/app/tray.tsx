import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { copyPrice } from '@/api/binders';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { DefaultsLine } from '@/components/defaults-line';
import { Icon, type IconName } from '@/components/icon';
import { TrayButton } from '@/components/tray-bar';
import { EmptyState } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { changeTrayCard, clearTray, removeFromTray, useTray, valuesOf, type TrayCard } from '@/scan/tray';
import { colors, fonts, radius, type } from '@/theme';

// The scanned cards before they're saved: one short row each; tap one to change or remove it.
export default function TrayScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tray = useTray();
  const { currency, scanTo } = usePreferences();
  const [peek] = useState(() => !peeked);
  useEffect(() => {
    peeked = true;
  }, []);
  // Saved, cleared or the last card removed: back to the scanner.
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
        ListHeaderComponent={tray.length > 0 && scanTo?.kind !== 'wishlist' ? <DefaultsLine finishOnly={scanTo !== null} /> : null}
        ListEmptyComponent={
          <EmptyState
            icon="document_scanner"
            title="Nothing scanned yet"
            body="Cards you scan wait here until you add them."
            action={{ label: 'Scan cards', onPress: () => router.back() }}
          />
        }
        renderItem={({ item, index }) => {
          const price = copyPrice(item.printing.prices, valuesOf(item).finish, currency);
          return (
            <SwipeRow card={item} peek={peek && index === 0}>
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
            </SwipeRow>
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

/** How far a row opens to show − and +. */
const ACTIONS_WIDTH = 120;
/** The list shows once per app run that its rows swipe: the first one slides open a little and back. */
let peeked = false;

/**
 * A tray row that swipes left to show − and + for the copies (− on the last copy removes it). A shortcut: the card
 * sheet a tap opens does the same.
 */
function SwipeRow({ card, peek, children }: { card: TrayCard; peek: boolean; children: ReactNode }) {
  const x = useSharedValue(0);
  useEffect(() => {
    if (peek) {
      x.value = withDelay(
        400,
        withSequence(withTiming(-ACTIONS_WIDTH, { duration: 350 }), withDelay(1000, withSpring(0, { damping: 18, stiffness: 160 }))),
      );
    }
  }, [peek, x]);
  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onChange((event) => {
      x.value = Math.max(-ACTIONS_WIDTH, Math.min(0, x.value + event.changeX));
    })
    .onEnd(() => {
      x.value = withSpring(-x.value > ACTIONS_WIDTH / 2 ? -ACTIONS_WIDTH : 0, { damping: 20, stiffness: 220 });
    });
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const step = (by: 1 | -1) => {
    if (card.copies + by < 1) removeFromTray(card.key);
    else changeTrayCard(card.key, { copies: Math.min(99, card.copies + by) });
  };
  return (
    <View>
      <View style={styles.actions}>
        <StepButton icon="add" label={`One more ${card.printing.name}`} onPress={() => step(1)} />
        <StepButton icon="remove" label={`One fewer ${card.printing.name}`} onPress={() => step(-1)} />
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.front, rowStyle]}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

function StepButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.step, pressed && { opacity: 0.7 }]}
    >
      <Icon name={icon} size={20} tintColor={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: 20, paddingBottom: 120, gap: 6 },
  clear: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.lavender },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  front: { backgroundColor: colors.background },
  actions: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingRight: 4,
  },
  step: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
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
