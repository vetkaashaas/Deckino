import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { cardCount, deleteBinder, exportBinder, publicBinderUrl, updateBinder, useBinder } from '@/api/binders';
import { showDialog } from '@/components/dialog';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { fileName, shareFile } from '@/components/share-file';
import { attempt } from '@/components/toast';
import { Button, ListRow, SwitchRow } from '@/components/ui';
import { colors, radius } from '@/theme';

// Everything about a binder that isn't its cards: name, Public, Selling, share, delete.
export default function BinderSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const binder = useBinder(id).data;
  const [edited, setName] = useState<string | null>(null);
  const name = edited ?? binder?.name ?? '';
  const form = useSubmit();
  if (!binder) return null;

  async function done() {
    if (name.trim() === binder!.name) {
      router.back();
      return;
    }
    if (await form.submit(async () => void (await updateBinder(id, { name: name.trim() })))) router.back();
  }

  function confirmDelete() {
    const cards = binder!.cards.length;
    showDialog(
      `Delete ${binder!.name}?`,
      cards > 0 ? `Its ${cardCount(cards)} go too. This can't be undone.` : "This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            void attempt(async () => {
              await deleteBinder(id);
              router.dismissAll(); // also when opened from the scanner's toast, not from Collection
              router.navigate('/collection');
            }),
        },
      ],
    );
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
      <View style={styles.panel}>
        <SwitchRow
          title="Public"
          detail="Anyone with the link can see it"
          value={binder.isPublic}
          onChange={(isPublic) => void attempt(() => updateBinder(id, { isPublic }))}
        />
        <SwitchRow
          title="Selling"
          detail="Marks the cards as for sale"
          value={binder.isSelling}
          onChange={(isSelling) => void attempt(() => updateBinder(id, { isSelling }))}
        />
        <ListRow
          title="Share link"
          detail={binder.isPublic ? publicBinderUrl(id).replace('https://', '') : 'Turn on Public to share it'}
          onPress={binder.isPublic ? () => void Share.share({ message: publicBinderUrl(id) }) : undefined}
        />
        <ListRow
          title="Share the card list"
          detail="A spreadsheet file ManaBox and Deckbox read"
          onPress={() => void attempt(async () => shareFile(fileName(binder.name, 'csv'), await exportBinder(id), 'text/csv'))}
        />
      </View>
      <View style={styles.panel}>
        <ListRow title="Delete binder" onPress={confirmDelete} />
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
