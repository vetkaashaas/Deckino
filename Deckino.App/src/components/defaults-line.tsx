import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';

import { finishLabel } from '@/components/card-sheet';
import { LANGUAGES, usePreferences } from '@/preferences';
import { colors, fonts, type } from '@/theme';

/** How new cards go in, said once above a list of them: "Adding as NM · English · Non-foil · Change". */
export function DefaultsLine() {
  const router = useRouter();
  const { condition, language, finish } = usePreferences();
  const languageName = LANGUAGES.find((l) => l.value === language)?.label ?? language;
  return (
    <Pressable
      onPress={() => router.push('/defaults')}
      accessibilityRole="button"
      accessibilityLabel={`Adding as ${condition}, ${languageName}, ${finishLabel(finish)}. Change`}
      style={styles.line}
    >
      <Text style={type.label}>
        Adding as {condition} · {languageName} · {finishLabel(finish)} · <Text style={styles.change}>Change</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: { paddingVertical: 6 },
  change: { fontFamily: fonts.body, fontWeight: '700', color: colors.lavender },
});
