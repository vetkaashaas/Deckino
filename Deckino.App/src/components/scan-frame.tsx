import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '@/theme';

export type ScanTone = 'idle' | 'detecting' | 'locked' | 'rejected';

const CARD_ASPECT_RATIO = 63 / 88;
const CORNER = 36;
const STROKE = 4;
const CORNER_RADIUS = 20;

const TONE_COLORS: Record<ScanTone, string> = {
  idle: 'rgba(255, 255, 255, 0.85)',
  detecting: colors.pink,
  locked: colors.success,
  rejected: colors.danger,
};

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

/**
 * Card-shaped viewfinder: dims the camera outside the guide, draws glowing
 * corner brackets tinted by scan state, and sweeps a laser line while searching.
 */
export function ScanFrame({ tone }: { tone: ScanTone }) {
  const guideHeight = useSharedValue(0);
  const sweep = useSharedValue(0);
  const pop = useSharedValue(1);
  const scanning = tone !== 'locked';

  useEffect(() => {
    if (scanning) {
      sweep.value = 0;
      sweep.value = withRepeat(
        withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      cancelAnimation(sweep);
    }
  }, [scanning, sweep]);

  useEffect(() => {
    if (tone === 'locked') {
      pop.value = withSequence(
        withTiming(1.04, { duration: 120 }),
        withSpring(1, { damping: 12, stiffness: 180 }),
      );
    }
  }, [pop, tone]);

  const lineStyle = useAnimatedStyle(() => ({
    opacity: scanning ? 1 : withTiming(0, { duration: 200 }),
    transform: [{ translateY: sweep.value * Math.max(0, guideHeight.value - 2) }],
  }));

  const guideStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pop.value }],
  }));

  const color = TONE_COLORS[tone];

  return (
    <View style={styles.layer} pointerEvents="none">
      <Animated.View
        style={[styles.guide, guideStyle]}
        onLayout={(event) => {
          guideHeight.value = event.nativeEvent.layout.height;
        }}
      >
        {(Object.keys(CORNER_STYLES) as CornerPosition[]).map((position) => (
          <View
            key={position}
            style={[
              styles.corner,
              CORNER_STYLES[position],
              // drop-shadow follows the bracket stroke; boxShadow would glow the whole box.
              { borderColor: color, filter: `drop-shadow(0px 0px 6px ${color})` },
            ]}
          />
        ))}
        <Animated.View style={[styles.line, lineStyle]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guide: {
    width: '72%',
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
  line: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: 2,
    borderRadius: 1,
    experimental_backgroundImage: `linear-gradient(90deg, rgba(222, 65, 144, 0) 0%, ${colors.pink} 30%, ${colors.purple} 70%, rgba(152, 29, 206, 0) 100%)`,
    boxShadow: `0 0 14px 2px rgba(222, 65, 144, 0.7)`,
  },
});
