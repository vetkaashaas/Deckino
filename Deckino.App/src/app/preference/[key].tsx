import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { useBinders } from '@/api/binders';
import { CHOICES, setPreferences, usePreferences, type ChoiceKey, type Preferences } from '@/preferences';
import { colors, radius, type } from '@/theme';

// One preference's options, Android settings style: tap one and go back.
export default function PreferenceScreen() {
  const router = useRouter();
  const key = useLocalSearchParams<{ key: ChoiceKey }>().key;
  const preferences = usePreferences();
  const binders = useBinders().data ?? [];
  const choice = CHOICES[key];
  if (!choice) return null;
  const options =
    key === 'defaultBinderId'
      ? [...choice.options, ...binders.map((b) => ({ value: b.id, label: b.name }))]
      : choice.options;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: choice.title }} />
      {key === 'defaultBinderId' ? (
        <Text style={[type.body, styles.note]}>Where scanned cards go. The scanner remembers the binder you chose last.</Text>
      ) : key === 'currency' ? null : (
        <Text style={[type.body, styles.note]}>For the cards you add from now on. You can change each card later.</Text>
      )}
      {options.map((option) => {
        const selected = preferences[key] === option.value;
        return (
          <Pressable
            key={option.value ?? 'none'}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => {
              // Choosing where scans go also stops scanning into a deck.
              setPreferences({ [key]: option.value, ...(key === 'defaultBinderId' ? { scanDeckId: null } : {}) } as Partial<Preferences>);
              router.back();
            }}
            style={({ pressed }) => [styles.option, selected && styles.selected, pressed && styles.pressed]}
          >
            <Text style={[type.body, styles.label]}>{option.label}</Text>
            {selected ? (
              <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={20} tintColor={colors.lavender} />
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 8, paddingBottom: 48 },
  note: { color: colors.textMuted, marginBottom: 8 },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  selected: { borderColor: colors.lavender, backgroundColor: 'rgba(152, 29, 206, 0.22)' },
  pressed: { opacity: 0.8 },
  label: { flex: 1 },
});
