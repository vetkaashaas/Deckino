import { useSyncExternalStore } from 'react';

import type { Printing } from '@/api/cards';

// Development and E2E builds only: the card deckino://e2e-scan "locked" on, shown in the scanner's result card as if
// the camera had (the emulator's camera can't see a real card; Deckino.App/AGENTS.md). Null otherwise.

export interface E2ELock {
  oracleId: string;
  name: string;
  printing: Printing;
}

let lock: E2ELock | null = null;
const listeners = new Set<() => void>();

/** A card to show, or null when the scanner closes (as a real lock ends when the card leaves). */
export function setE2ELock(next: E2ELock | null) {
  if (lock === next) return;
  lock = next;
  listeners.forEach((listener) => listener());
}

export function useE2ELock(): E2ELock | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => lock,
  );
}
