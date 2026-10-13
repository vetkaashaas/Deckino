import { changeWishlist, undoWishlist } from '@/api/wishlist';
import { CardSearch } from '@/components/card-search';
import { attempt, showToast } from '@/components/toast';

// Add to the wishlist by name: one copy of that printing each tap.
export default function AddToWishlistScreen() {
  return (
    <CardSearch
      defaults="none"
      onAdd={async (card) => {
        const applied = await changeWishlist([{ scryfallId: card.id, quantity: 1 }]);
        showToast({ message: `Added ${card.name}`, undo: () => void attempt(() => undoWishlist(applied)) });
      }}
    />
  );
}
