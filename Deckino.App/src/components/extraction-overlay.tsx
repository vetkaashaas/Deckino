import { StyleSheet, Text, View } from 'react-native';

import type { CornerName } from '@/extraction/types';
import { colors } from '@/theme';

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

function Edge({
  from,
  to,
  color,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1) {
    return null;
  }
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <View
      style={[
        styles.edge,
        {
          left: (from.x + to.x) / 2 - length / 2,
          top: (from.y + to.y) / 2 - 1.5,
          width: length,
          backgroundColor: color,
          boxShadow: `0 0 10px ${color}`,
          transform: [{ rotate: `${angle}deg` }],
        },
      ]}
    />
  );
}

export function ExtractionOverlay({
  points,
  accepted,
  showLabels = true,
}: {
  points: OverlayPoint[] | null;
  accepted: boolean;
  showLabels?: boolean;
}) {
  if (points === null || points.length < 4) {
    return null;
  }
  const color = accepted ? colors.pink : colors.danger;
  return (
    <View pointerEvents="none" style={styles.layer}>
      {points.map((point, index) => (
        <Edge
          key={`e-${point.name}`}
          from={point}
          to={points[(index + 1) % points.length]}
          color={color}
        />
      ))}
      {points.map((point) => (
        <View
          key={point.name}
          style={[
            styles.dot,
            { left: point.x - 6, top: point.y - 6, backgroundColor: color },
          ]}
        >
          {showLabels ? (
          <View
            style={[
              styles.label,
              LABEL_OFFSETS[point.name],
              { borderColor: color },
            ]}
          >
            <Text numberOfLines={1} style={styles.labelText}>
              {CORNER_LABELS[point.name]}
            </Text>
          </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    zIndex: 20,
    elevation: 20,
  },
  edge: {
    position: 'absolute',
    height: 3,
  },
  dot: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#FFFFFF',
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
