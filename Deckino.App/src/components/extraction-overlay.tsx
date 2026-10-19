import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { toneColor, type ScanTone } from '@/components/scan-frame';
import type { CornerName } from '@/extraction/types';
import { colors } from '@/theme';

// The scanner's corners are the logo (assets/images/brand/icon-white.svg): its four pieces wait in the guide around
// the star, slowly turning. A card opens them out to its corners while the star fades, and they stay on them (a pop
// when it is recognized) until no card is seen; then they glide back into the logo and the star fades back in.

const LOGO_CENTRE = 190;
/** The logo's four pieces in its 380-unit box, in TopLeft, TopRight, BottomRight, BottomLeft order; `apex` is the
 * point that sits on the card's corner. */
const PIECES = [
  {
    apex: [56.86, 90.47],
    points: [170.74, 140.24, 164.34, 96.14, 56.86, 90.47, 92.97, 191.74, 137.09, 185.32, 107.39, 128.19],
  },
  {
    apex: [289.9, 56.89],
    points: [289.9, 56.89, 188.55, 92.6, 194.96, 136.74, 252.18, 107.42, 240.01, 170.38, 284.15, 163.97],
  },
  {
    apex: [323.15, 288.62],
    points: [287.65, 188.19, 243.55, 194.59, 272.62, 250.91, 209.9, 239.66, 216.31, 283.8, 323.15, 288.62],
  },
  {
    apex: [90.91, 323.11],
    points: [185.68, 243.19, 128.63, 272.58, 140.6, 209.55, 96.48, 215.94, 90.91, 323.11, 192.08, 287.3],
  },
].map((piece) => ({
  ...piece,
  // The direction from the apex into the logo, lined up with the way into the card at its corner.
  inward: Math.atan2(LOGO_CENTRE - piece.apex[1], LOGO_CENTRE - piece.apex[0]),
}));
// The star, its curves sampled into points (the logo's path, 44 points).
const STAR = [
  221.1, 185.5, 220.6, 179.5, 220.8, 173.5, 221.8, 167.6, 223.5, 161.9, 234.5, 131.1, 207.7, 150.4, 202.7, 153.6, 197.4,
  156.1, 191.8, 158.0, 186.0, 159.2, 185.7, 159.2, 179.8, 159.7, 173.9, 159.5, 168.0, 158.6, 162.3, 156.9, 131.1, 145.9,
  150.6, 172.5, 153.8, 177.5, 156.4, 182.9, 158.3, 188.6, 159.5, 194.4, 159.6, 194.5, 160.0, 200.5, 159.8, 206.4, 158.9,
  212.2, 157.2, 217.9, 146.3, 248.9, 172.8, 229.6, 177.9, 226.4, 183.2, 223.9, 188.8, 222.0, 194.7, 220.8, 195.3, 220.7,
  201.0, 220.2, 206.8, 220.4, 212.5, 221.2, 218.0, 222.8, 248.9, 233.2, 230.1, 207.5, 226.8, 202.4, 224.2, 197.0, 222.3,
  191.4,
];
/** How wide the logo is in its box, apex to apex. */
const LOGO_SPAN = 267;
/** A piece on a card is this big for each point of the card's shorter edge (about a fifth of the card across). */
const PIECE_PER_EDGE = 0.002;
/** On a card the pieces sit this far (per point of its shorter edge) out past its corners, diagonally, so they frame
 * the card instead of covering its art. */
const OUTSET_PER_EDGE = 0.05;
const CORNER_ORDER: CornerName[] = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
/** How long the corners take to glide to each new set of points: about the time between analysed frames. */
const GLIDE_MS = 80;
/** The waiting logo is see-through, so it doesn't hide the table; the pieces turn solid on a card. */
const IDLE_OPACITY = 0.4;

const IDLE_COLOR = toneColor('idle');
/** The pop's flash: the violet nearly at white. */
const FLASH_COLOR = '#F3E6FF';

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

/** Where the logo waits with no card: the guide's centre and the logo's width there. */
export interface LogoRest {
  x: number;
  y: number;
  width: number;
}

const lerp = (from: number[], to: number[], t: number) => {
  'worklet';
  return to.map((value, i) => from[i] + (value - from[i]) * t);
};

/** From angle a towards b (radians) the short way round. */
const turn = (a: number, b: number, t: number) => {
  'worklet';
  const full = Math.PI * 2;
  const d = ((((b - a) % full) + full * 1.5) % full) - Math.PI;
  return a + d * t;
};

/** "M…Z" for `points` (x, y, …) turned by `angle` and scaled by `scale` about (ox, oy), which lands on (x, y). */
function placed(points: number[], ox: number, oy: number, x: number, y: number, angle: number, scale: number): string {
  'worklet';
  const cos = Math.cos(angle) * scale;
  const sin = Math.sin(angle) * scale;
  let d = '';
  for (let i = 0; i < points.length; i += 2) {
    const px = points[i] - ox;
    const py = points[i + 1] - oy;
    d += `${i === 0 ? 'M' : 'L'}${x + px * cos - py * sin},${y + px * sin + py * cos}`;
  }
  return `${d}Z`;
}

/**
 * The card the extractor found, marked by the logo's pieces on its corners and coloured by how the scan is going.
 * With `rest`, the logo waits there while no card is in view; without, the pieces show only on a card.
 */
export function ExtractionOverlay({
  points,
  tone,
  rest,
  showLabels = false,
}: {
  points: OverlayPoint[] | null;
  tone: ScanTone;
  rest?: LogoRest | null;
  /** Debug: name each corner. */
  showLabels?: boolean;
}) {
  // The corners glide from where they are drawn now (from → to by t) to each new set of points.
  const from = useSharedValue<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const to = useSharedValue<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const t = useSharedValue(1);
  /** 1 with the pieces out on the card's corners, 0 closed into the logo. */
  const open = useSharedValue(0);
  /** Where the closed logo waits. */
  const centre = useSharedValue<number[]>([rest?.x ?? 0, rest?.y ?? 0]);
  const spin = useSharedValue(0);
  const pop = useSharedValue(1);
  /** 1 at the peak of the pop's flash. */
  const flash = useSharedValue(0);
  const shown = useSharedValue(rest ? 1 : 0);
  /** The pieces' colour out on a card; it stays as they close, blending back to the waiting logo's white. */
  const cardColor = useSharedValue(toneColor('detecting'));
  const hasCard = points !== null && points.length >= 4;
  const restX = rest?.x ?? null;
  const restY = rest?.y ?? null;
  const isLocked = hasCard && tone === 'locked';

  useEffect(() => {
    // Each turn starts again from 0, which looks the same as a full turn: from any other angle the restart would jump.
    spin.value = 0;
    spin.value = withRepeat(withTiming(Math.PI * 2, { duration: 14000, easing: Easing.linear }), -1, false);
  }, [spin]);

  useEffect(() => {
    if (restX !== null && restY !== null) centre.value = [restX, restY];
  }, [restX, restY, centre]);

  useEffect(() => {
    if (!hasCard) {
      // Slowly, so a card lost for a frame or two barely moves them.
      open.value = withTiming(0, { duration: 600, easing: Easing.inOut(Easing.cubic) });
      shown.value = withTiming(restX !== null ? 1 : 0, { duration: 150 });
      return;
    }
    const byName = CORNER_ORDER.map((name) => points.find((point) => point.name === name) ?? points[0]);
    const next = byName.flatMap((point) => [point.x, point.y]);
    // With the pieces closed into the logo the corners jump to the card (the pieces then fly out to them); on a card
    // they glide on from where they are drawn.
    from.value = open.value < 0.05 ? next : lerp(from.value, to.value, t.value);
    to.value = next;
    t.value = 0;
    t.value = withTiming(1, { duration: GLIDE_MS, easing: Easing.out(Easing.quad) });
    shown.value = withTiming(1, { duration: 120 });
    open.value = withTiming(1, { duration: 260, easing: Easing.inOut(Easing.cubic) });
  }, [points, hasCard, restX, from, to, t, open, shown]);

  useEffect(() => {
    if (tone !== 'idle') cardColor.value = toneColor(tone);
  }, [tone, cardColor]);

  // The pieces on the card pop and flash when it is recognized.
  useEffect(() => {
    if (!isLocked) return;
    pop.value = withSequence(withTiming(1.5, { duration: 140 }), withSpring(1, { damping: 10, stiffness: 160 }));
    flash.value = withSequence(withTiming(1, { duration: 140 }), withTiming(0, { duration: 400 }));
  }, [isLocked, pop, flash]);

  const restWidth = rest?.width ?? 0;
  // Where each piece is: closed into the waiting logo blended with out on the card's corner by `open`.
  const piecesProps = useAnimatedProps(() => {
    const c = lerp(from.value, to.value, t.value);
    const logoAngle = spin.value;
    const logoScale = (restWidth || 120) / LOGO_SPAN;
    let shortest = Infinity;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      shortest = Math.min(shortest, Math.hypot(c[2 * j] - c[2 * i], c[2 * j + 1] - c[2 * i + 1]));
    }
    const cardScale = (Number.isFinite(shortest) ? shortest * PIECE_PER_EDGE : logoScale) * pop.value;
    let d = '';
    for (let i = 0; i < 4; i++) {
      const piece = PIECES[i];
      const cos = Math.cos(logoAngle);
      const sin = Math.sin(logoAngle);
      const ax = (piece.apex[0] - LOGO_CENTRE) * logoScale;
      const ay = (piece.apex[1] - LOGO_CENTRE) * logoScale;
      const closedX = centre.value[0] + ax * cos - ay * sin;
      const closedY = centre.value[1] + ax * sin + ay * cos;
      const cx = c[2 * i];
      const cy = c[2 * i + 1];
      const prev = (i + 3) % 4;
      const next = (i + 1) % 4;
      const pl = Math.hypot(c[2 * prev] - cx, c[2 * prev + 1] - cy) || 1;
      const nl = Math.hypot(c[2 * next] - cx, c[2 * next + 1] - cy) || 1;
      const inward = Math.atan2(
        (c[2 * prev + 1] - cy) / pl + (c[2 * next + 1] - cy) / nl,
        (c[2 * prev] - cx) / pl + (c[2 * next] - cx) / nl,
      );
      const outset = Number.isFinite(shortest) ? shortest * OUTSET_PER_EDGE : 0;
      const x = cx - Math.cos(inward) * outset;
      const y = cy - Math.sin(inward) * outset;
      const o = open.value;
      d += placed(
        piece.points,
        piece.apex[0],
        piece.apex[1],
        closedX + (x - closedX) * o,
        closedY + (y - closedY) * o,
        turn(logoAngle, inward - piece.inward, o),
        logoScale + (cardScale - logoScale) * o,
      );
    }
    return {
      d,
      opacity: IDLE_OPACITY + (1 - IDLE_OPACITY) * open.value,
      fill: interpolateColor(
        flash.value,
        [0, 1],
        [interpolateColor(open.value, [0, 1], [IDLE_COLOR, cardColor.value]), FLASH_COLOR],
      ),
    };
  });
  const starProps = useAnimatedProps(() => ({
    d: placed(
      STAR,
      LOGO_CENTRE,
      LOGO_CENTRE,
      centre.value[0],
      centre.value[1],
      spin.value,
      (restWidth || 120) / LOGO_SPAN,
    ),
    opacity: IDLE_OPACITY * (1 - open.value),
  }));
  const layerStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const color = toneColor(tone);
  return (
    <View pointerEvents="none" style={styles.layer}>
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle]}>
        <Svg style={StyleSheet.absoluteFill}>
          <AnimatedPath animatedProps={piecesProps} />
          <AnimatedPath animatedProps={starProps} fill={IDLE_COLOR} />
        </Svg>
      </Animated.View>
      {showLabels && hasCard
        ? points.map((point) => (
            <View
              key={point.name}
              style={[
                styles.label,
                {
                  left: point.x + LABEL_OFFSETS[point.name].left,
                  top: point.y + LABEL_OFFSETS[point.name].top,
                  borderColor: color,
                },
              ]}
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
