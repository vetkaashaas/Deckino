import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { cardCount, useBinders } from '@/api/binders';
import { useDecks } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { CardImage } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { saveTray, stepLast, trayCount, useTray, useWaitingCards, type TrayTarget } from '@/scan/tray';
import { colors, fonts, gradients, radius } from '@/theme';

/** Where the tray goes: the deck or wishlist being scanned into, else the default binder; undefined until chosen. */
export function useTrayTarget(): TrayTarget | undefined {
  const { defaultBinderId, scanTo, currency } = usePreferences();
  const deckId = scanTo?.kind === 'deck' ? scanTo.id : null;
  const deck = useDecks(deckId !== null).data?.find((d) => d.id === deckId);
  const binder = useBinders(currency).data?.find((b) => b.id === defaultBinderId);
  if (scanTo?.kind === 'wishlist') return { kind: 'wishlist', id: '', name: 'your wishlist' };
  if (deckId) return deck && { kind: 'deck', id: deck.id, name: deck.name };
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
        <Icon name="expand_more" size={22} tintColor={colors.text} />
      </Pressable>
    </View>
  );
}

/**
 * The tray at the bottom of the scanner: the last cards scanned, − and + for its copies, and "View 3 cards". Saving
 * (or signing in to save) happens on the tray screen, so the scanner stays clean. Above it, cards scanned without
 * signal that join once it is back.
 */
export function TrayBar() {
  const waiting = useWaitingCards();
  // The note floats above the bar, so the scanner's guide doesn't move when it comes and goes.
  return (
    <View>
      {waiting.length > 0 ? (
        <Animated.View entering={FadeIn} style={styles.waiting}>
          <Icon name="wifi_off" size={16} tintColor={colors.textMuted} />
          <Text style={styles.waitingLabel}>{cardCount(waiting.length)} waiting for a connection</Text>
        </Animated.View>
      ) : null}
      <TrayCards />
    </View>
  );
}

function TrayCards() {
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
        style={[styles.stack, { width: THUMB + STEP * (recent.length - 1) }]}
      >
        {recent.map((card, index) => (
          <Animated.View
            key={card.key}
            entering={ZoomIn.springify()}
            style={[styles.thumb, { left: index * STEP, zIndex: index }]}
          >
            <CardImage uri={card.printing.smallImage ?? card.printing.image} name="" branded />
          </Animated.View>
        ))}
      </Pressable>
      {/* How many of the last card, between the buttons that change it: − stays put (dimmed at one) so + doesn't move. */}
      <View style={styles.stepper}>
        <Pressable
          onPress={() => stepLast(-1)}
          disabled={last.copies <= 1}
          accessibilityRole="button"
          accessibilityLabel={`One fewer ${last.printing.name}`}
          hitSlop={6}
          style={({ pressed }) => [styles.step, last.copies <= 1 && styles.disabled, pressed && styles.pressed]}
        >
          <Icon name="remove" size={20} tintColor={colors.text} />
        </Pressable>
        <Text style={styles.copies} accessibilityLabel={`${last.copies} of ${last.printing.name}`}>
          {last.copies}
        </Text>
        <Pressable
          onPress={() => stepLast(1)}
          accessibilityRole="button"
          accessibilityLabel={`One more ${last.printing.name}`}
          hitSlop={6}
          style={({ pressed }) => [styles.step, pressed && styles.pressed]}
        >
          <Icon name="add" size={20} tintColor={colors.text} />
        </Pressable>
      </View>
      <View style={styles.flex}>
        <Pressable
          onPress={() => router.push('/tray')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.view, pressed && styles.pressed]}
        >
          <Icon name="visibility" size={18} tintColor={colors.text} />
          <Text style={styles.label}>View {cardCount(trayCount(tray))}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const THUMB = 34;
const STEP = 14; // each newer thumbnail sits this far right (TRAY_THUMB in the scanner)

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
  stack: { height: THUMB / (63 / 88), justifyContent: 'center' },
  thumb: { position: 'absolute', top: 0, width: THUMB, boxShadow: '0 2px 6px rgba(0, 0, 0, 0.5)' },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  step: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  copies: {
    minWidth: 20,
    textAlign: 'center',
    fontFamily: fonts.heading,
    fontSize: 16,
    fontWeight: '800',
    color: colors.text,
  },
  view: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  waiting: {
    position: 'absolute',
    left: 0,
    bottom: '100%',
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  waitingLabel: { fontFamily: fonts.body, fontSize: 14, color: colors.textMuted },
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
  disabled: { opacity: 0.35 },
});
