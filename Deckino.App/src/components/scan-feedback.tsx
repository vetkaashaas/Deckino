import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import type { Ownership } from '@/api/wishlist';
import { CardImage } from '@/components/card-visuals';
import { CARD_ASPECT_RATIO } from '@/components/scan-frame';
import { colors, fonts, radius } from '@/theme';

// The scanner's light feedback (AppPlan, Phase A5): a small pill naming the card, a hint only when something is
// wrong, and the card flying into the tray. The camera keeps the screen.

export interface ResultBadge {
  label: string;
  tone: 'have' | 'want' | 'deck' | 'none';
}

const BADGE_COLORS: Record<ResultBadge['tone'], string> = {
  have: colors.success,
  want: colors.pink,
  deck: colors.lavender,
  none: colors.textMuted,
};

/** "You have 2 · On your wishlist · In Goblins": what you have of a scanned card, in plain words (A7). */
export function badgesFor({ owned, wanted, decks }: Ownership): ResultBadge[] {
  return [
    owned > 0 ? { label: `You have ${owned}`, tone: 'have' } : { label: 'You don’t have it', tone: 'none' },
    ...(wanted > 0 ? [{ label: wanted > 1 ? `On your wishlist ×${wanted}` : 'On your wishlist', tone: 'want' as const }] : []),
    ...(decks.length > 0
      ? [{ label: decks.length > 1 ? `In ${decks[0].name} +${decks.length - 1}` : `In ${decks[0].name}`, tone: 'deck' as const }]
      : []),
  ];
}

/** The card just added: "Lightning Bolt · $1.20", then what you have of it. */
export function ScanToast({
  name,
  detail,
  badges,
  onPress,
}: {
  name: string;
  detail: string;
  badges?: ResultBadge[];
  /** Opens the card. */
  onPress: () => void;
}) {
  return (
    <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(200)} style={styles.toast}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityHint="Opens the card"
        style={({ pressed }) => [styles.toastRow, pressed && styles.pressed]}
      >
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
        <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={16} tintColor={colors.textMuted} />
      </Pressable>
      {badges && badges.length > 0 ? (
        <View style={styles.badges}>
          {badges.map((badge) => (
            <Text key={badge.label} style={[styles.badge, { color: BADGE_COLORS[badge.tone], borderColor: BADGE_COLORS[badge.tone] }]}>
              {badge.label}
            </Text>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
}

/** What to fix, only when something stops the scan: "Fit the whole card in the frame". */
export function ScanHint({ text }: { text: string }) {
  return (
    <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(200)} style={[styles.toast, styles.hint]}>
      <SymbolView name={{ ios: 'exclamationmark.triangle.fill', android: 'warning' }} size={16} tintColor={colors.danger} />
      <Text style={styles.hintText}>{text}</Text>
    </Animated.View>
  );
}

/** A point on screen and a card width there; the card's centre. */
export interface CardSpot {
  x: number;
  y: number;
  width: number;
}

/** The added card shrinking from the frame into the tray, once. */
export function FlyingCard({ uri, from, to, onDone }: { uri: string | null; from: CardSpot; to: CardSpot; onDone: () => void }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: 500, easing: Easing.inOut(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
    // Once, as it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.85, 1], [1, 1, 0]),
    transform: [
      { translateX: (to.x - from.x) * progress.value },
      { translateY: (to.y - from.y) * progress.value },
      { scale: 1 + (to.width / from.width - 1) * progress.value },
    ],
  }));
  const height = from.width / CARD_ASPECT_RATIO;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.flying, { left: from.x - from.width / 2, top: from.y - height / 2, width: from.width }, style]}
    >
      <CardImage uri={uri} name="" transition={0} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    alignSelf: 'center',
    maxWidth: '100%',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.lg,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
  },
  toastRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  pressed: { opacity: 0.7 },
  name: { flexShrink: 1, fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.text },
  detail: { fontFamily: fonts.body, fontSize: 15, color: colors.textMuted },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  hintText: { flexShrink: 1, fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.text },
  flying: { position: 'absolute', zIndex: 50, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)' },
});
