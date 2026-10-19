import { BottomSheet, Column, Host, Switch, Text } from '@expo/ui';
import { StyleSheet } from 'react-native';

import { colors } from '@/theme';

// The sheet (debug toggles, model status) ships in development and E2E builds only (debugTools in preferences.ts):
// scan sound, haptics and training photos live in Profile. Its settings are kept across starts.

/** Native bottom sheet with scanner toggles and model status lines. */
export function ScannerSettingsSheet({
  isPresented,
  onDismiss,
  showHud,
  onShowHudChange,
  showCornerLabels,
  onShowCornerLabelsChange,
  highAccuracy,
  onHighAccuracyChange,
  modelUpdates,
  onModelUpdatesChange,
  blockTrainingUploads,
  onBlockTrainingUploadsChange,
  statusLines,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  showHud: boolean;
  onShowHudChange: (value: boolean) => void;
  showCornerLabels: boolean;
  onShowCornerLabelsChange: (value: boolean) => void;
  highAccuracy: boolean;
  onHighAccuracyChange: (value: boolean) => void;
  modelUpdates: boolean;
  onModelUpdatesChange: (value: boolean) => void;
  blockTrainingUploads: boolean;
  onBlockTrainingUploadsChange: (value: boolean) => void;
  statusLines: string[];
}) {
  return (
    <Host
      matchContents
      colorScheme="dark"
      seedColor={colors.purple}
      style={styles.host}
    >
      <BottomSheet
        isPresented={isPresented}
        onDismiss={onDismiss}
        showDragIndicator
        contentPadding={{ left: 24, right: 24, bottom: 32 }}
      >
        <Column spacing={16}>
          <Text textStyle={{ fontSize: 20, fontWeight: '700' }}>
            Scanner settings
          </Text>
          <Switch
            label="High accuracy scans"
            value={highAccuracy}
            onValueChange={onHighAccuracyChange}
          />
          <Switch
            label="Debug HUD"
            value={showHud}
            onValueChange={onShowHudChange}
          />
          <Switch
            label="Corner labels"
            value={showCornerLabels}
            onValueChange={onShowCornerLabelsChange}
          />
          <Switch
            label="Download model updates"
            value={modelUpdates}
            onValueChange={onModelUpdatesChange}
          />
          <Switch
            label="Never upload training data"
            value={blockTrainingUploads}
            onValueChange={onBlockTrainingUploadsChange}
          />
          <Column spacing={4}>
            <Text
              textStyle={{
                fontSize: 12,
                fontWeight: '700',
                letterSpacing: 1,
                color: colors.textDim,
              }}
            >
              MODELS
            </Text>
            {statusLines.map((line) => (
              <Text
                key={line}
                textStyle={{ fontSize: 13, color: colors.textMuted }}
              >
                {line}
              </Text>
            ))}
          </Column>
        </Column>
      </BottomSheet>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
  },
});
