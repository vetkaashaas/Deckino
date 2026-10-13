import { useLocalSearchParams, useRouter } from 'expo-router';

import { changeWishlist, removeWanted, updateWanted, useWishlist } from '@/api/wishlist';
import { CardSheet } from '@/components/card-sheet';
import { attempt, showToast } from '@/components/toast';

// The card sheet for a wishlist row (the same sheet as a binder row): the printing you want, and how many.
export default function WishlistCardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const entry = useWishlist().data?.find((e) => e.id === id);
  if (!entry) return null; // loading, or just removed

  async function remove() {
    if (await attempt(() => removeWanted(id))) {
      router.back();
      showToast({
        message: `Removed ${entry!.card.name}`,
        undo: () => void attempt(() => changeWishlist([{ scryfallId: entry!.scryfallId, quantity: entry!.quantity }])),
      });
    }
  }

  return (
    <CardSheet
      initial={{ printing: entry.card, copies: entry.quantity }}
      unchecked={false}
      removeLabel="Remove from wishlist"
      onSave={(values) =>
        void attempt(() => updateWanted(id, { scryfallId: values.printing.id, quantity: values.copies })).then(
          (saved) => saved && router.back(),
        )
      }
      onRemove={() => void remove()}
    />
  );
}
