import { useEffect } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';

import type { Finish } from '@/api/binders';
import { getJson } from '@/api/client';
import type { CardDetail, Printing } from '@/api/cards';
import { addToTray } from '@/scan/tray';

// Development and E2E builds only: deckino://e2e-scan?id=<printing> puts that printing in the scan tray as if the
// camera had locked on it, since the emulator's camera can't see a real card (Deckino.App/AGENTS.md).
const enabled = __DEV__ || process.env.EXPO_PUBLIC_E2E === '1';

export default function E2EScan() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      const [card, printings] = await Promise.all([
        getJson<CardDetail>(`/api/cards/${id}`),
        getJson<Printing[]>(`/api/cards/${id}/printings`),
      ]);
      const printing = printings.find((p) => p.id === id) ?? printings[0];
      addToTray({
        ...printing,
        oracleId: card.oracleId,
        name: card.name,
        illustrationId: null,
        smallImage: printing.image,
        finishes: printing.finishes as Finish[],
      });
      router.dismissTo('/scan');
    })();
  }, [id, router]);
  return enabled ? null : <Redirect href="/" />;
}
