import { useLocalSearchParams, useRouter } from 'expo-router';

import { CardSheet } from '@/components/card-sheet';
import { changeTrayCard, removeFromTray, useTray, valuesOf } from '@/scan/tray';

// The card sheet for a scanned card in the tray (the same sheet as a binder row).
export default function TrayCardScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const router = useRouter();
  const card = useTray().find((c) => c.key === key);
  if (!card) return null; // just removed
  return (
    <CardSheet
      initial={{ printing: card.printing, copies: card.copies, ...valuesOf(card) }}
      unchecked={!card.confirmed}
      removeLabel="Remove from tray"
      onSave={(values) => {
        changeTrayCard(key, { ...values, confirmed: true });
        router.back();
      }}
      onRemove={() => {
        router.back();
        removeFromTray(key);
      }}
    />
  );
}
