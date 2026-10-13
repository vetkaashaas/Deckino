import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';

import { addCards, cardCount, finishFor, removeCards, type BinderPrinting, type Finish } from '@/api/binders';
import { ApiError } from '@/api/client';
import { attempt, showToast } from '@/components/toast';
import { getPreferences, setPreferences } from '@/preferences';

// The scan tray (AppPlan, Phase A5): cards scanned and not yet saved to a binder. Kept on the phone, so a session
// survives the app closing or losing signal, and signing in.
// ponytail: the whole tray is rewritten to SecureStore on each change; fine for a few hundred cards, move it to a
// file if trays get bigger than that.

export interface TrayCard {
  key: string;
  printing: BinderPrinting;
  copies: number;
  /** Set when changed in the card sheet; until then the "Adding as …" defaults apply, also when they change. */
  finish?: Finish;
  condition?: string;
  language?: string;
  /** The user saved the card sheet, so the printing was seen; otherwise the binder says to check it. */
  confirmed: boolean;
}

const KEY = 'deckino.tray';
const listeners = new Set<() => void>();
let tray = read();

function read(): TrayCard[] {
  try {
    const raw = SecureStore.getItem(KEY);
    return raw ? (JSON.parse(raw) as TrayCard[]) : [];
  } catch {
    return [];
  }
}

function set(next: TrayCard[]) {
  tray = next;
  try {
    SecureStore.setItem(KEY, JSON.stringify(tray));
  } catch (error) {
    console.warn('tray: could not save', error); // kept until the app closes
  }
  listeners.forEach((listener) => listener());
}

export const getTray = () => tray;

export function useTray(): TrayCard[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tray,
  );
}

/** The values a tray card goes in with: its own, else today's defaults. */
export function valuesOf(card: TrayCard) {
  const preferences = getPreferences();
  return {
    finish: card.finish ?? finishFor(card.printing.finishes, preferences.finish),
    condition: card.condition ?? preferences.condition,
    language: card.language ?? preferences.language,
  };
}

let nextKey = Date.now();

/** A scanned card drops in at the end. */
export function addToTray(printing: BinderPrinting) {
  set([...tray, { key: String(nextKey++), printing, copies: 1, confirmed: false }]);
}

/** The +1 on the tray: another copy of the last card. */
export function addCopyOfLast() {
  const last = tray.at(-1);
  if (last) changeTrayCard(last.key, { copies: Math.min(99, last.copies + 1) });
}

export function changeTrayCard(key: string, change: Partial<TrayCard>) {
  set(tray.map((card) => (card.key === key ? { ...card, ...change } : card)));
}

export function removeFromTray(key: string) {
  const index = tray.findIndex((card) => card.key === key);
  const removed = tray[index];
  if (!removed) return;
  set(tray.filter((card) => card.key !== key));
  showToast({
    message: `Removed ${removed.printing.name}`,
    undo: () => set([...tray.slice(0, index), removed, ...tray.slice(index)]),
  });
}

export function clearTray() {
  const cleared = tray;
  set([]);
  showToast({ message: 'Tray cleared', undo: () => set([...cleared, ...tray]) });
}

export const trayCount = (cards: TrayCard[]) => cards.reduce((sum, card) => sum + card.copies, 0);

let saving = false;

/** Adds the whole tray to a binder in one request, then empties it. Undo takes the cards out and puts the tray back. */
export async function saveTray(binder: { id: string; name: string }): Promise<boolean> {
  if (saving || tray.length === 0) return false;
  saving = true;
  const cards = tray;
  let added: string[] = [];
  try {
    const saved = await attempt(async () => {
      try {
        added = await addCards(
          binder.id,
          cards.map((card) => ({
            card: { scryfallId: card.printing.id, ...valuesOf(card), printingConfirmed: card.confirmed },
            copies: card.copies,
          })),
        );
      } catch (error) {
        // Deleted elsewhere (the website): forget it, so the button asks where next time.
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        setPreferences({ defaultBinderId: null });
        throw new Error(`${binder.name} is gone. Choose another binder.`);
      }
    });
    if (!saved) return false;
    set(tray.filter((card) => !cards.includes(card))); // anything scanned meanwhile stays
    showToast({
      message: `Added ${cardCount(trayCount(cards))} to ${binder.name}`,
      onPress: () => router.push({ pathname: '/binder/[id]', params: { id: binder.id } }),
      undo: () =>
        void attempt(async () => {
          await removeCards(binder.id, added);
          set([...cards, ...tray]);
        }),
    });
    return true;
  } finally {
    saving = false;
  }
}
