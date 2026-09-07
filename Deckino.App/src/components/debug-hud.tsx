import { StyleSheet, Text, View } from 'react-native';

export interface HudStats {
  cameraFps: number;
  analysisFps: number;
  latencyMs: number;
  width: number;
  height: number;
  recognizerName: string;
  extractorName?: string;
  resizeMs?: number;
  inferMs?: number;
  decodeMs?: number;
  presence?: number;
  accepted?: boolean;
  rejectionReason?: string | null;
  delegate?: string;
}

export function DebugHud({ stats }: { stats: HudStats | null }) {
  if (stats === null) {
    return null;
  }
  return (
    <View style={styles.panel}>
      <Text style={styles.row}>{stats.recognizerName}</Text>
      {stats.extractorName ? (
        <Text style={styles.row}>{stats.extractorName}</Text>
      ) : null}
      <Text style={styles.row}>
        {stats.cameraFps.toFixed(0)} fps cam / {stats.analysisFps.toFixed(1)}{' '}
        fps scan
      </Text>
      {stats.resizeMs !== undefined &&
      stats.inferMs !== undefined &&
      stats.decodeMs !== undefined ? (
        <>
          <Text style={styles.row}>
            {(stats.resizeMs + stats.inferMs + stats.decodeMs).toFixed(1)} ms
            total
          </Text>
          <Text style={styles.row}>
            {stats.resizeMs.toFixed(1)} resize / {stats.inferMs.toFixed(1)} infer
            / {stats.decodeMs.toFixed(1)} decode
          </Text>
        </>
      ) : (
        <Text style={styles.row}>{stats.latencyMs.toFixed(2)} ms resize</Text>
      )}
      {stats.presence !== undefined ? (
        <Text style={styles.row}>
          presence {(stats.presence * 100).toFixed(1)}%{' '}
          {stats.accepted ? 'accepted' : stats.rejectionReason ?? 'rejected'}
          {stats.delegate ? ` · ${stats.delegate}` : ''}
        </Text>
      ) : null}
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
    maxWidth: '100%',
    alignSelf: 'flex-start',
  },
  row: {
    color: '#7CFC9A',
    fontFamily: 'monospace',
    fontSize: 11,
  },
});
