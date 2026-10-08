import { BottomSheet, Column, Host, Switch, Text } from '@expo/ui';
import { StyleSheet } from 'react-native';

import { colors } from '@/theme';

/** Native bottom sheet with scanner debug toggles and model status lines. */
export function ScannerSettingsSheet({
  isPresented,
  onDismiss,
  showHud,
  onShowHudChange,
  showCornerLabels,
  onShowCornerLabelsChange,
  trainingUpload,
  statusLines,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  showHud: boolean;
  onShowHudChange: (value: boolean) => void;
  showCornerLabels: boolean;
  onShowCornerLabelsChange: (value: boolean) => void;
  /** Null when this build has no training upload configured. */
  trainingUpload: { enabled: boolean; onChange: (value: boolean) => void } | null;
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
            label="Debug HUD"
            value={showHud}
            onValueChange={onShowHudChange}
          />
          <Switch
            label="Corner labels"
            value={showCornerLabels}
            onValueChange={onShowCornerLabelsChange}
          />
          {trainingUpload !== null && (
            <Switch
              label="Upload scans for training"
              value={trainingUpload.enabled}
              onValueChange={trainingUpload.onChange}
            />
          )}
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
