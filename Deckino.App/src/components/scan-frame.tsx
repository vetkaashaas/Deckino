import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { colors } from '@/theme';

export type ScanTone = 'idle' | 'detecting' | 'locked' | 'rejected';

export const CARD_ASPECT_RATIO = 63 / 88;
const CORNER = 36;
const STROKE = 4;
const CORNER_RADIUS = 20;

const TONE_COLORS: Record<ScanTone, string> = {
  idle: 'rgba(255, 255, 255, 0.85)',
  detecting: colors.violet,
  locked: colors.success,
  rejected: colors.danger,
};

/** The colour of a scan state: white idle, violet reading, green identified, red when something's off. */
export const toneColor = (tone: ScanTone) => TONE_COLORS[tone];

type CornerPosition = 'tl' | 'tr' | 'br' | 'bl';

const CORNER_STYLES: Record<CornerPosition, object> = {
  tl: {
    top: 0,
    left: 0,
    borderTopWidth: STROKE,
    borderLeftWidth: STROKE,
    borderTopLeftRadius: CORNER_RADIUS,
  },
  tr: {
    top: 0,
    right: 0,
    borderTopWidth: STROKE,
    borderRightWidth: STROKE,
    borderTopRightRadius: CORNER_RADIUS,
  },
  br: {
    bottom: 0,
    right: 0,
    borderBottomWidth: STROKE,
    borderRightWidth: STROKE,
    borderBottomRightRadius: CORNER_RADIUS,
  },
  bl: {
    bottom: 0,
    left: 0,
    borderBottomWidth: STROKE,
    borderLeftWidth: STROKE,
    borderBottomLeftRadius: CORNER_RADIUS,
  },
};

/** Where the guide may go: the free band between the scanner's top and bottom controls. */
export type GuideArea = { y: number; width: number; height: number };

const GUIDE_MARGIN = 16;

/** The guide's width in `area`: 72% of it, smaller when that would not fit its height. */
export function guideWidth(area: GuideArea): number {
  return Math.min(area.width * 0.72, Math.max(0, area.height - 2 * GUIDE_MARGIN) * CARD_ASPECT_RATIO);
}

/**
 * Card-shaped viewfinder: dims the camera outside the guide and draws glowing corner brackets tinted by scan state.
 * The brackets fade while a card's own corners are drawn (ExtractionOverlay), so there's one set at a time.
 */
export function ScanFrame({ tone, area, cardInView }: { tone: ScanTone; area: GuideArea | null; cardInView: boolean }) {
  const pop = useSharedValue(1);
  const brackets = useSharedValue(1);

  useEffect(() => {
    if (tone === 'locked') {
      pop.value = withSequence(withTiming(1.04, { duration: 120 }), withSpring(1, { damping: 12, stiffness: 180 }));
    }
  }, [pop, tone]);

  useEffect(() => {
    brackets.value = withTiming(cardInView ? 0 : 1, { duration: 200 });
  }, [brackets, cardInView]);

  const guideStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const bracketStyle = useAnimatedStyle(() => ({ opacity: brackets.value }));

  const color = TONE_COLORS[tone];
  if (area === null) return null; // not laid out yet

  return (
    <View style={[styles.layer, { top: area.y, height: area.height }]} pointerEvents="none">
      <Animated.View style={[styles.guide, { width: guideWidth(area) }, guideStyle]}>
        {(Object.keys(CORNER_STYLES) as CornerPosition[]).map((position) => (
          <Animated.View
            key={position}
            style={[
              styles.corner,
              CORNER_STYLES[position],
              // drop-shadow follows the bracket stroke; boxShadow would glow the whole box.
              { borderColor: color, filter: `drop-shadow(0px 0px 6px ${color})` },
              bracketStyle,
            ]}
          />
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guide: {
    aspectRatio: CARD_ASPECT_RATIO,
    borderRadius: CORNER_RADIUS,
    // A huge spread shadow dims everything outside the card guide.
    boxShadow: '0 0 0 2000px rgba(11, 6, 16, 0.45)',
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
  },
});
