import { ScrollView, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';

import { Icon } from '@/components/icon';
import { ListRow } from '@/components/ui';
import { choiceLabel, usePreferences, type ChoiceKey } from '@/preferences';
import { colors, type } from '@/theme';

// How new cards go in, reached from "Adding as … · Change" (the same settings as in Profile).
export default function DefaultsScreen() {
  const router = useRouter();
  const preferences = usePreferences();
  const row = (key: ChoiceKey, title: string) => (
    <ListRow
      title={title}
      trailing={
        <>
          <Text style={type.label}>{choiceLabel(key, preferences)}</Text>
          <Icon name="chevron_right" size={18} tintColor={colors.textDim} />
        </>
      }
      onPress={() => router.push(`/preference/${key}`)}
    />
  );
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[type.body, styles.note]}>For the cards you add from now on. You can change each card later.</Text>
      {row('condition', 'Condition')}
      {row('language', 'Language')}
      {row('finish', 'Finish')}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 4 },
  note: { color: colors.textMuted, marginBottom: 8 },
});
