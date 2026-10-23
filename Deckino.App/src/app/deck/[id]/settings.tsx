import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { changeDeck, deleteDeck, exportDeck, publicDeckUrl, setDeckPublic, useDeck } from '@/api/decks';
import { showDialog } from '@/components/dialog';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { FormatChoice } from '@/components/format-choice';
import { fileName, shareFile } from '@/components/share-file';
import { attempt } from '@/components/toast';
import { Button, ListRow, SwitchRow } from '@/components/ui';
import { colors, radius } from '@/theme';

// Everything about a deck that isn't its cards: name, format, Public, share, delete.
export default function DeckSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const deck = useDeck(id).data;
  const [edited, setName] = useState<string | null>(null);
  const name = edited ?? deck?.name ?? '';
  const form = useSubmit();
  if (!deck) return null;

  async function done() {
    if (name.trim() === deck!.name) {
      router.back();
      return;
    }
    if (await form.submit(async () => void (await changeDeck(id, () => ({ name: name.trim() }))))) router.back();
  }

  function confirmDelete() {
    showDialog(`Delete ${deck!.name}?`, "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void attempt(async () => {
            await deleteDeck(id);
            router.dismissAll(); // also when opened from the scanner's toast, not from Decks
            router.navigate('/decks');
          }),
      },
    ]);
  }

  return (
    <FormScreen actions={<Button label={form.busy ? 'Saving…' : 'Done'} onPress={() => void done()} />}>
      <FormMessage message={form.message} />
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        error={form.fields.name}
        autoCapitalize="sentences"
        maxLength={100}
        onSubmitEditing={() => void done()}
      />
      <FormatChoice value={deck.format} onChange={(format) => void attempt(() => changeDeck(id, () => ({ format })))} />
      <View style={styles.panel}>
        <SwitchRow
          title="Public"
          detail="Anyone with the link can see it"
          value={deck.isPublic}
          onChange={(isPublic) => void attempt(() => setDeckPublic(id, isPublic))}
        />
        <ListRow
          title="Share link"
          detail={deck.isPublic ? publicDeckUrl(id).replace('https://', '') : 'Turn on Public to share it'}
          onPress={deck.isPublic ? () => void Share.share({ message: publicDeckUrl(id) }) : undefined}
        />
        <ListRow
          title="Share the decklist"
          detail="A text file Arena, MTGO and deck builders read"
          onPress={() => void attempt(async () => shareFile(fileName(deck.name, 'txt'), await exportDeck(id), 'text/plain'))}
        />
      </View>
      <View style={styles.panel}>
        <ListRow title="Delete deck" onPress={confirmDelete} />
      </View>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
});
