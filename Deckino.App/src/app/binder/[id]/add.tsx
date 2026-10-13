import { useLocalSearchParams } from 'expo-router';

import { addCards, removeCards } from '@/api/binders';
import { CardSearch } from '@/components/card-search';
import { attempt, showToast } from '@/components/toast';
import { getPreferences } from '@/preferences';

// Add to a binder by name, with the Profile's condition and language.
export default function AddToBinderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <CardSearch
      onAdd={async (card, finish) => {
        const { condition, language } = getPreferences();
        const added = await addCards(id, [{ card: { scryfallId: card.id, condition, language, finish }, copies: 1 }]);
        showToast({ message: `Added ${card.name}`, undo: () => void attempt(() => removeCards(id, added)) });
      }}
    />
  );
}
