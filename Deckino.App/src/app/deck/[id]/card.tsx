import { useLocalSearchParams, useRouter } from 'expo-router';

import type { Finish } from '@/api/binders';
import { changeDeck, putEntry, sectionLabel, takeEntry, useDeck, type SectionName } from '@/api/decks';
import { CardSheet, type SheetValues } from '@/components/card-sheet';
import { attempt, showToast } from '@/components/toast';

// The card sheet for a deck row (the same sheet as a binder row): printing, finish, copies and which part of the
// deck it's in.
export default function DeckCardScreen() {
  const { id, section, scryfallId, finish } = useLocalSearchParams<{
    id: string;
    section: SectionName;
    scryfallId: string;
    finish: Finish;
  }>();
  const router = useRouter();
  const deck = useDeck(id).data;
  const entry = deck?.[section].find((e) => e.scryfallId === scryfallId && e.finish === finish);
  if (!deck || !entry) return null; // loading, or just removed
  const was = { scryfallId, quantity: entry.quantity, finish };
  const commander = deck.format === 'commander';

  const sections: { value: SectionName; label: string }[] = [
    // A Background is the second commander of a "Choose a Background" one.
    ...(commander && (entry.card.canBeCommander || entry.card.typeLine?.includes('Background'))
      ? [{ value: 'commander' as const, label: 'Commander' }]
      : []),
    { value: 'mainboard', label: sectionLabel('mainboard', deck.format) },
    { value: 'sideboard', label: sectionLabel('sideboard', deck.format) },
  ];

  // A commander is one card; in Commander the rest are singletons unless the card says otherwise.
  function maxCopies(values: SheetValues) {
    if (values.section === 'commander') return 1;
    if (commander && values.section === 'mainboard') return entry!.card.singletonCopies ?? 99;
    return 99;
  }

  async function save(values: SheetValues) {
    const to = values.section as SectionName;
    // Moving to Commander takes one copy; any others stay where they were.
    const moved = to === section ? was.quantity : Math.min(was.quantity, values.copies);
    const saved = await attempt(() =>
      changeDeck(id, (cards) => {
        const next = { ...cards, [section]: takeEntry(cards[section], { ...was, quantity: moved }) };
        next[to] = putEntry(next[to], { scryfallId: values.printing.id, quantity: values.copies, finish: values.finish });
        return { cards: next };
      }),
    );
    if (saved) router.back();
  }

  async function remove() {
    if (await attempt(() => changeDeck(id, (cards) => ({ cards: { ...cards, [section]: takeEntry(cards[section], was) } })))) {
      router.back();
      showToast({
        message: `Removed ${entry!.card.name}`,
        undo: () => void attempt(() => changeDeck(id, (cards) => ({ cards: { ...cards, [section]: putEntry(cards[section], was) } }))),
      });
    }
  }

  return (
    <CardSheet
      initial={{ printing: entry.card, finish, copies: entry.quantity, section }}
      unchecked={false}
      removeLabel="Remove from deck"
      sections={sections}
      maxCopies={maxCopies}
      onSave={(values) => void save(values)}
      onRemove={() => void remove()}
    />
  );
}
