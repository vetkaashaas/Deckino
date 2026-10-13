import { ScrollView, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { cardCount, useBinders } from '@/api/binders';
import { ListRow } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
import { saveTray } from '@/scan/tray';
import { colors, type } from '@/theme';

// Where the scanned cards go: the binders, or a new one. Remembered for next time. `save`: add them right away.
export default function TrayBinderScreen() {
  const { save } = useLocalSearchParams<{ save?: string }>();
  const router = useRouter();
  const { defaultBinderId, currency } = usePreferences();
  const binders = useBinders(currency).data;

  function choose(binder: { id: string; name: string }) {
    setPreferences({ defaultBinderId: binder.id });
    router.back();
    if (save) void saveTray(binder);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[type.body, styles.note]}>Add the scanned cards to:</Text>
      {binders?.map((binder) => (
        <ListRow
          key={binder.id}
          title={binder.name}
          detail={cardCount(binder.cardCount)}
          trailing={
            binder.id === defaultBinderId ? (
              <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={20} tintColor={colors.lavender} />
            ) : null
          }
          onPress={() => choose(binder)}
        />
      ))}
      <ListRow
        leading={<SymbolView name={{ ios: 'plus', android: 'add' }} size={22} tintColor={colors.lavender} />}
        title="New binder"
        onPress={() => router.push({ pathname: '/binder/new', params: { then: 'scan' } })}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 4 },
  note: { color: colors.textMuted, marginBottom: 8 },
});
