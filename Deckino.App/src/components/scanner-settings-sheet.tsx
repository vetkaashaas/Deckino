import { BottomSheet, Column, Host, Switch, Text } from '@expo/ui';
import { StyleSheet } from 'react-native';

import { colors } from '@/theme';

// The debug toggles ship in development and E2E builds only; scan sound, haptics and
// training photos live in Profile.
const debugTools = __DEV__ || process.env.EXPO_PUBLIC_E2E === '1';

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
          {debugTools && (
            <Switch
              label="Debug HUD"
              value={showHud}
              onValueChange={onShowHudChange}
            />
          )}
          {debugTools && (
            <Switch
              label="Corner labels"
              value={showCornerLabels}
              onValueChange={onShowCornerLabelsChange}
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
