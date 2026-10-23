import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  addCards,
  groupCopies,
  removeCards,
  restoreCards,
  updateCard,
  useBinder,
  type BinderDetail,
} from '@/api/binders';
import { queryClient } from '@/api/query-client';
import { CardSheet, type SheetValues } from '@/components/card-sheet';
import { attempt, showToast } from '@/components/toast';
import { Button } from '@/components/ui';

// The card sheet for a binder row: the row's copies (ids), changed together. `check` walks through the cards
// whose printing nobody has checked, one after another.
export default function BinderCardScreen() {
  const { id, ids, check } = useLocalSearchParams<{ id: string; ids: string; check?: string }>();
  const router = useRouter();
  const binder = useBinder(id).data;
  const wanted = ids.split(',');
  const copies = binder?.cards.filter((c) => wanted.includes(c.id)) ?? [];
  if (copies.length === 0) return null; // loading, or just removed
  const first = copies[0];

  async function save(values: SheetValues) {
    const card = {
      scryfallId: values.printing.id,
      finish: values.finish!,
      condition: values.condition!,
      language: values.language!,
      notes: first.notes,
    };
    const same =
      first.printingConfirmed &&
      card.scryfallId === first.scryfallId &&
      card.finish === first.finish &&
      card.condition === first.condition &&
      card.language === first.language;
    const saved = await attempt(async () => {
      const drop = copies.slice(values.copies);
      if (drop.length > 0) await removeCards(id, drop.map((c) => c.id));
      // Saving marks the printing checked.
      if (!same) for (const c of copies.slice(0, values.copies)) await updateCard(id, c.id, card);
      if (values.copies > copies.length) await addCards(id, [{ card, copies: values.copies - copies.length }]);
    });
    if (!saved) return;
    if (check) {
      const latest = queryClient.getQueryData<BinderDetail>(['binder', id]);
      const next = latest && groupCopies(latest.cards).find((g) => !g.copies[0].printingConfirmed);
      if (next) {
        router.setParams({ ids: next.copies.map((c) => c.id).join(',') });
        return;
      }
    }
    router.back();
  }

  async function remove() {
    if (await attempt(() => removeCards(id, copies.map((c) => c.id)))) {
      router.back();
      showToast({ message: `Removed ${first.card.name}`, undo: () => void attempt(() => restoreCards(id, copies)) });
    }
  }

  return (
    <CardSheet
      key={ids} // the next card to check starts afresh
      initial={{
        printing: first.card,
        finish: first.finish,
        condition: first.condition,
        language: first.language,
        copies: copies.length,
      }}
      unchecked={!first.printingConfirmed}
      removeLabel="Remove from binder"
      onSave={(values) => void save(values)}
      onRemove={() => void remove()}
      extra={
        <Button
          label="Move to another binder"
          variant="secondary"
          icon="drive_file_move"
          onPress={() => router.push({ pathname: '/binder/[id]/move', params: { id, ids } })}
        />
      }
    />
  );
}
