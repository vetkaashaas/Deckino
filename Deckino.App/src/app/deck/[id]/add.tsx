import { useLocalSearchParams } from 'expo-router';

import { changeDeck, putEntry, takeEntry } from '@/api/decks';
import { CardSearch } from '@/components/card-search';
import { attempt, showToast } from '@/components/toast';

// Add to a deck by name: one copy into the main deck each tap.
export default function AddToDeckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <CardSearch
      forDeck
      onAdd={async (card, finish) => {
        const entry = { scryfallId: card.id, quantity: 1, finish };
        await changeDeck(id, (cards) => ({ cards: { ...cards, mainboard: putEntry(cards.mainboard, entry) } }));
        showToast({
          message: `Added ${card.name}`,
          undo: () =>
            void attempt(() => changeDeck(id, (cards) => ({ cards: { ...cards, mainboard: takeEntry(cards.mainboard, entry) } }))),
        });
      }}
    />
  );
}
