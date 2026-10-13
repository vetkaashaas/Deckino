import { StyleSheet, Text, View } from 'react-native';

import { FORMATS } from '@/api/decks';
import { Chip } from '@/components/ui';
import { type } from '@/theme';

export function FormatChoice({ value, onChange }: { value: string; onChange: (format: string) => void }) {
  return (
    <View style={styles.formats}>
      <Text style={type.label}>Format</Text>
      <View style={styles.chips}>
        {FORMATS.map((f) => (
          <Chip key={f.value} label={f.label} selected={f.value === value} onPress={() => onChange(f.value)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  formats: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
