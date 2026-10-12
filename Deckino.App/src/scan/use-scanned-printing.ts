import { useState } from 'react';

import { usePrintingsByArtwork, type Printing } from '@/api/cards';

/**
 * The printing a locked scan starts on: the newest normal printing with the matched artwork (the API's choice),
 * or the card's default printing when the artwork is unknown. Null while there is no lock or no answer yet.
 */
export function useScannedPrinting(oracleId: string | null, illustrationId: string | null): Printing | null {
  // The artwork of the first locked frame stays while the card does: later frames may match another of its
  // artworks, and each change would ask the API again.
  const [artwork, setArtwork] = useState<{ oracleId: string; illustrationId: string | null } | null>(null);
  if ((artwork?.oracleId ?? null) !== oracleId) {
    setArtwork(oracleId === null ? null : { oracleId, illustrationId });
  }
  const printings = usePrintingsByArtwork(artwork?.oracleId ?? null, artwork?.illustrationId ?? null);
  return printings.data?.[0] ?? null;
}
