import { useLocalSearchParams, useRouter } from 'expo-router';

import { CardSheet } from '@/components/card-sheet';
import { usePreferences } from '@/preferences';
import { changeTrayCard, removeFromTray, useTray, valuesOf } from '@/scan/tray';

// The card sheet for a scanned card in the tray (the same sheet as a binder row). Going to a deck: no condition or
// language.
export default function TrayCardScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const router = useRouter();
  const card = useTray().find((c) => c.key === key);
  const toDeck = usePreferences().scanDeckId !== null;
  if (!card) return null; // just removed
  const { finish, condition, language } = valuesOf(card);
  return (
    <CardSheet
      initial={{ printing: card.printing, copies: card.copies, finish, ...(toDeck ? {} : { condition, language }) }}
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
