import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { toneColor, type ScanTone } from '@/components/scan-frame';
import type { CornerName } from '@/extraction/types';
import { colors } from '@/theme';

/** How long each arm of a corner is, at most; a quarter of the shorter edge on a small card. */
const ARM = 30;
/** How long the corners take to glide to each new set of points: about the time between analysed frames, so they
 * keep moving without falling behind the card. */
const GLIDE_MS = 80;

const AnimatedPath = Animated.createAnimatedComponent(Path);

const LABEL_WIDTH = 84;
const CORNER_LABELS: Record<CornerName, string> = {
  TopLeft: 'Top left',
  TopRight: 'Top right',
  BottomRight: 'Bottom right',
  BottomLeft: 'Bottom left',
};

const LABEL_OFFSETS: Record<CornerName, { left: number; top: number }> = {
  TopLeft: { left: 16, top: -28 },
  TopRight: { left: -LABEL_WIDTH - 4, top: -28 },
  BottomRight: { left: -LABEL_WIDTH - 4, top: 16 },
  BottomLeft: { left: 16, top: 16 },
};

export interface OverlayPoint {
  x: number;
  y: number;
  name: CornerName;
}

/** "M a L corner L b": an L on each corner, its arms along the card's two edges. `c` is x0, y0, … x3, y3. */
function cornersPath(c: number[]): string {
  'worklet';
  let shortest = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    shortest = Math.min(shortest, Math.hypot(c[2 * j] - c[2 * i], c[2 * j + 1] - c[2 * i + 1]));
  }
  const arm = Math.min(ARM, shortest / 4);
  if (!Number.isFinite(arm) || arm < 2) return 'M0,0';
  let path = '';
  for (let i = 0; i < 4; i++) {
    const x = c[2 * i];
    const y = c[2 * i + 1];
    const ends = [(i + 3) % 4, (i + 1) % 4].map((k) => {
      const dx = c[2 * k] - x;
      const dy = c[2 * k + 1] - y;
      const length = Math.hypot(dx, dy);
      return `${x + (dx / length) * arm},${y + (dy / length) * arm}`;
    });
    path += `M${ends[0]} L${x},${y} L${ends[1]} `;
  }
  return path;
}

const lerp = (from: number[], to: number[], t: number) => {
  'worklet';
  return to.map((value, i) => from[i] + (value - from[i]) * t);
};

/** The card the extractor found, marked by its four corners, coloured by how the scan is going. */
export function ExtractionOverlay({
  points,
  tone,
  showLabels = false,
}: {
  points: OverlayPoint[] | null;
  tone: ScanTone;
  /** Debug: name each corner. */
  showLabels?: boolean;
}) {
  // The corners glide from where they are drawn now (from → to by t) to each new set of points.
  const from = useSharedValue<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const to = useSharedValue<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const t = useSharedValue(1);
  const shown = useSharedValue(0);
  const hasCard = points !== null && points.length >= 4;
  useEffect(() => {
    if (points === null || points.length < 4) {
      shown.value = withTiming(0, { duration: 150 });
      return;
    }
    const next = points.flatMap((point) => [point.x, point.y]);
    // A card coming into view starts where it is; one moving glides on from where its corners are drawn.
    from.value = shown.value < 0.05 ? next : lerp(from.value, to.value, t.value);
    to.value = next;
    t.value = 0;
    t.value = withTiming(1, { duration: GLIDE_MS, easing: Easing.out(Easing.quad) });
    shown.value = withTiming(1, { duration: 120 });
  }, [points, from, to, t, shown]);
  const pathProps = useAnimatedProps(() => ({ d: cornersPath(lerp(from.value, to.value, t.value)) }));
  const layerStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const color = toneColor(tone);
  return (
    <View pointerEvents="none" style={styles.layer}>
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle]}>
        <Svg style={StyleSheet.absoluteFill}>
          {/* A wide faint stroke beneath for the glow. */}
          <AnimatedPath animatedProps={pathProps} stroke={color} strokeOpacity={0.3} strokeWidth={12} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <AnimatedPath animatedProps={pathProps} stroke={color} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </Svg>
      </Animated.View>
      {showLabels && hasCard
        ? points.map((point) => (
            <View
              key={point.name}
              style={[styles.label, { left: point.x + LABEL_OFFSETS[point.name].left, top: point.y + LABEL_OFFSETS[point.name].top, borderColor: color }]}
            >
              <Text numberOfLines={1} style={styles.labelText}>
                {CORNER_LABELS[point.name]}
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    zIndex: 20,
    elevation: 20,
  },
  label: {
    position: 'absolute',
    width: LABEL_WIDTH,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderWidth: 1,
    borderRadius: 6,
    backgroundColor: colors.glass,
  },
  labelText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
});
