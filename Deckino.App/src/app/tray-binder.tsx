import { ScrollView, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { cardCount, useBinders } from '@/api/binders';
import { formatLabel, useDecks } from '@/api/decks';
import { ListRow } from '@/components/ui';
import { setPreferences, usePreferences } from '@/preferences';
import { saveTray, type TrayTarget } from '@/scan/tray';
import { colors, type } from '@/theme';

// Where the scanned cards go: a binder, a new one, or a deck. Remembered for next time. `save`: add them right away.
export default function TrayBinderScreen() {
  const { save } = useLocalSearchParams<{ save?: string }>();
  const router = useRouter();
  const { defaultBinderId, scanDeckId, currency } = usePreferences();
  const binders = useBinders(currency).data;
  const decks = useDecks().data;

  function choose(target: TrayTarget) {
    setPreferences(target.kind === 'deck' ? { scanDeckId: target.id } : { defaultBinderId: target.id, scanDeckId: null });
    router.back();
    if (save) void saveTray(target);
  }

  const tick = <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={20} tintColor={colors.lavender} />;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[type.body, styles.note]}>Add the scanned cards to:</Text>
      <Text style={[type.label, styles.heading]} accessibilityRole="header">
        Binders
      </Text>
      {binders?.map((binder) => (
        <ListRow
          key={binder.id}
          title={binder.name}
          detail={cardCount(binder.cardCount)}
          trailing={!scanDeckId && binder.id === defaultBinderId ? tick : null}
          onPress={() => choose({ kind: 'binder', id: binder.id, name: binder.name })}
        />
      ))}
      <ListRow
        leading={<SymbolView name={{ ios: 'plus', android: 'add' }} size={22} tintColor={colors.lavender} />}
        title="New binder"
        onPress={() => router.push({ pathname: '/binder/new', params: { then: 'scan' } })}
      />
      {decks && decks.length > 0 ? (
        <>
          <Text style={[type.label, styles.heading]} accessibilityRole="header">
            Decks
          </Text>
          {decks.map((deck) => (
            <ListRow
              key={deck.id}
              title={deck.name}
              detail={`${formatLabel(deck.format)} · ${cardCount(deck.cardCount)}`}
              trailing={deck.id === scanDeckId ? tick : null}
              onPress={() => choose({ kind: 'deck', id: deck.id, name: deck.name })}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 4 },
  note: { color: colors.textMuted },
  heading: { marginTop: 12, marginBottom: 4 },
});
