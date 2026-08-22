import { StyleSheet, Text, View } from 'react-native';

export interface HudStats {
  cameraFps: number;
  analysisFps: number;
  latencyMs: number;
  width: number;
  height: number;
  recognizerName: string;
}

export function DebugHud({ stats }: { stats: HudStats | null }) {
  if (stats === null) {
    return null;
  }
  return (
    <View style={styles.panel}>
      <Text style={styles.row}>{stats.recognizerName}</Text>
      <Text style={styles.row}>
        {stats.cameraFps.toFixed(0)} fps cam / {stats.analysisFps.toFixed(1)}{' '}
        fps scan
      </Text>
      <Text style={styles.row}>{stats.latencyMs.toFixed(2)} ms scan</Text>
      <Text style={styles.row}>
        {stats.width}x{stats.height}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  row: {
    color: '#7CFC9A',
    fontFamily: 'monospace',
    fontSize: 11,
  },
});
