import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';

import { FORMATS, formatLabel } from '@/api/decks';
import { Icon } from '@/components/icon';
import { Chip, Sheet } from '@/components/ui';
import { colors, fonts, radius, type } from '@/theme';

// The deck's format: one row showing it, and the formats in a sheet, as the Decks tab picks one.
export function FormatChoice({ value, onChange }: { value: string; onChange: (format: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.formats}>
      <Text style={type.label}>Format</Text>
      <Pressable
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Format: ${formatLabel(value)}`}
        style={({ pressed }) => [styles.box, pressed && { opacity: 0.8 }]}
      >
        <Text style={styles.value}>{formatLabel(value)}</Text>
        <Icon name="expand_more" size={22} tintColor={colors.textMuted} />
      </Pressable>
      <Sheet visible={open} title="Format" onClose={() => setOpen(false)}>
        <View style={styles.chips}>
          {FORMATS.map((f) => (
            <Chip key={f.value} label={f.label} selected={f.value === value} onPress={() => onChange(f.value)} />
          ))}
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  formats: { gap: 6 },
  // As a text field looks (form.tsx), so it reads as one of the form's fields.
  box: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface,
  },
  value: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
