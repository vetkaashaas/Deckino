import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import type { Icon } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
import { colors, fonts, gradients, radius } from '@/theme';

const MODES: { value: 'add' | 'check'; label: string; icon: Icon }[] = [
  { value: 'add', label: 'Add', icon: { ios: 'plus', android: 'add' } },
  { value: 'check', label: 'Check', icon: { ios: 'eye', android: 'visibility' } },
];

/** The scanner's two jobs: add what it sees to the tray, or only check what you have of it (AppPlan, Phase A7). */
export function ScanModeSwitch() {
  const { scanMode } = usePreferences();
  return (
    <View style={styles.switch} accessibilityRole="radiogroup">
      {MODES.map((mode) => {
        const selected = mode.value === scanMode;
        return (
          <Pressable
            key={mode.value}
            onPress={() => setPreferences({ scanMode: mode.value })}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            style={[styles.option, selected && styles.selected]}
          >
            <SymbolView name={mode.icon} size={16} tintColor={colors.text} />
            <Text style={styles.label}>{mode.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  switch: {
    alignSelf: 'center',
    flexDirection: 'row',
    padding: 4,
    gap: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  option: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 18, borderRadius: radius.pill },
  selected: { experimental_backgroundImage: gradients.brand },
  label: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.text },
});
