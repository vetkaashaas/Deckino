import { StyleSheet, Text, View } from 'react-native';

import type { CornerName } from '@/extraction/types';

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
          transform: [{ rotate: `${angle}deg` }],
        },
      ]}
    />
  );
}

export function ExtractionOverlay({
  points,
  accepted,
}: {
  points: OverlayPoint[] | null;
  accepted: boolean;
}) {
  if (points === null || points.length < 4) {
    return null;
  }
  const color = accepted ? '#00D4FF' : '#FF5A5A';
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
          <Text style={styles.label}>{point.name}</Text>
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
  },
  label: {
    position: 'absolute',
    left: 14,
    top: -2,
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
});
