import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { cardCount, useBinders } from '@/api/binders';
import { useDecks } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { CardImage } from '@/components/card-visuals';
import { Button } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { addCopyOfLast, saveTray, trayCount, useTray, type TrayTarget } from '@/scan/tray';
import { colors, fonts, gradients, radius } from '@/theme';

/** Where the tray goes: the deck being scanned into, else the default binder; undefined until one is chosen. */
export function useTrayTarget(): TrayTarget | undefined {
  const { defaultBinderId, scanDeckId, currency } = usePreferences();
  const deck = useDecks(scanDeckId !== null).data?.find((d) => d.id === scanDeckId);
  const binder = useBinders(currency).data?.find((b) => b.id === defaultBinderId);
  if (scanDeckId) return deck && { kind: 'deck', id: deck.id, name: deck.name };
  return binder && { kind: 'binder', id: binder.id, name: binder.name };
}

/**
 * The button that saves the tray: "Add 5 cards to Trades ▾". The arrow chooses another binder or deck; with
 * nothing chosen yet the whole button does. Signed out: "Sign in to save these" (the tray stays).
 */
export function TrayButton() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const tray = useTray();
  const target = useTrayTarget();
  const count = cardCount(trayCount(tray));

  if (!signedIn) return <Button label="Sign in to save these" onPress={() => router.push('/sign-in')} />;
  const choose = (save: boolean) => router.push({ pathname: '/tray-binder', params: save ? { save: '1' } : {} });
  return (
    <View style={styles.button}>
      <Pressable
        onPress={() => (target ? void saveTray(target) : choose(true))}
        accessibilityRole="button"
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        <Text style={styles.label} numberOfLines={1}>
          {target ? `Add ${count} to ${target.name}` : `Add ${count}`}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => choose(false)}
        accessibilityRole="button"
        accessibilityLabel="Choose where they go"
        hitSlop={6}
        style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}
      >
        <SymbolView name={{ ios: 'chevron.down', android: 'expand_more' }} size={22} tintColor={colors.text} />
      </Pressable>
    </View>
  );
}

/** The tray at the bottom of the scanner: the last cards scanned, +1 for another copy, and the save button. */
export function TrayBar() {
  const router = useRouter();
  const tray = useTray();
  if (tray.length === 0) return null;
  const last = tray[tray.length - 1];
  const recent = tray.slice(-3);
  return (
    <Animated.View entering={FadeIn} style={styles.bar}>
      <Pressable
        onPress={() => router.push('/tray')}
        accessibilityRole="button"
        accessibilityLabel={`Scanned cards: ${cardCount(trayCount(tray))}. Last: ${last.printing.name}${last.copies > 1 ? ` ×${last.copies}` : ''}`}
        style={styles.stack}
      >
        {recent.map((card, index) => (
          <Animated.View
            key={card.key}
            entering={ZoomIn.springify()}
            style={[styles.thumb, { left: index * 14, zIndex: index }]}
          >
            <CardImage uri={card.printing.smallImage ?? card.printing.image} name="" />
          </Animated.View>
        ))}
        {last.copies > 1 ? <Text style={styles.copies}>×{last.copies}</Text> : null}
      </Pressable>
      <Pressable
        onPress={addCopyOfLast}
        accessibilityRole="button"
        accessibilityLabel={`One more ${last.printing.name}`}
        hitSlop={6}
        style={({ pressed }) => [styles.plus, pressed && styles.pressed]}
      >
        <Text style={styles.plusLabel}>+1</Text>
      </Pressable>
      <View style={styles.flex}>
        <TrayButton />
      </View>
    </Animated.View>
  );
}

const THUMB = 34;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 8,
    borderRadius: radius.lg,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  stack: { width: THUMB + 28, height: THUMB / (63 / 88), justifyContent: 'center' },
  thumb: { position: 'absolute', top: 0, width: THUMB, boxShadow: '0 2px 6px rgba(0, 0, 0, 0.5)' },
  copies: {
    position: 'absolute',
    right: -2,
    bottom: -4,
    zIndex: 10,
    fontFamily: fonts.heading,
    fontSize: 14,
    fontWeight: '800',
    color: colors.text,
    backgroundColor: colors.purple,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  plus: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  plusLabel: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '800', color: colors.text },
  flex: { flex: 1 },
  button: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 52,
    borderRadius: radius.pill,
    overflow: 'hidden',
    experimental_backgroundImage: gradients.brand,
  },
  main: { flex: 1, justifyContent: 'center', paddingLeft: 20, paddingRight: 8 },
  label: { fontFamily: fonts.body, fontSize: 16, fontWeight: '600', color: colors.text },
  arrow: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255, 255, 255, 0.25)',
  },
  pressed: { opacity: 0.8 },
});
