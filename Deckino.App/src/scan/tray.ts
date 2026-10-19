import { useSyncExternalStore } from 'react';
import { Image } from 'expo-image';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { isCancelledError } from '@tanstack/react-query';

import { addCards, cardCount, finishFor, removeCards, type BinderPrinting, type Finish } from '@/api/binders';
import { printingsByArtworkQuery } from '@/api/cards';
import { ApiError } from '@/api/client';
import { queryClient } from '@/api/query-client';
import { changeDeck, putEntry, takeEntry } from '@/api/decks';
import { changeWishlist, undoWishlist, type WishlistChange } from '@/api/wishlist';
import { attempt, showToast } from '@/components/toast';
import { getPreferences, setPreferences } from '@/preferences';

// The scan tray (AppPlan, Phases A5-A7): cards scanned and not yet saved to a binder, deck or the wishlist. Kept on the phone, so a session
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
  /** Looked up once the signal came back: it joins quietly, as it was named when it was scanned. */
  late?: boolean;
}

/** A card recognized without signal: it joins the tray once its printing can be looked up. */
export interface WaitingCard {
  oracleId: string;
  name: string;
  illustrationId: string | null;
}

const KEY = 'deckino.tray';
const WAITING_KEY = 'deckino.tray.waiting';
const listeners = new Set<() => void>();
let tray = read<TrayCard>(KEY);
let waiting = read<WaitingCard>(WAITING_KEY);

function read<T>(key: string): T[] {
  try {
    const raw = SecureStore.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function save(key: string, value: unknown) {
  try {
    SecureStore.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn('tray: could not save', error); // kept until the app closes
  }
  listeners.forEach((listener) => listener());
}

function set(next: TrayCard[]) {
  tray = next;
  save(KEY, tray);
}

function setWaiting(next: WaitingCard[]) {
  waiting = next;
  save(WAITING_KEY, waiting);
}

export const getTray = () => tray;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useTray = (): TrayCard[] => useSyncExternalStore(subscribe, () => tray);

export const useWaitingCards = (): WaitingCard[] => useSyncExternalStore(subscribe, () => waiting);

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
export function addToTray(printing: BinderPrinting, late = false) {
  set([...tray, { key: String(nextKey++), printing, copies: 1, confirmed: false, ...(late && { late }) }]);
}

/** Looks a recognized card's printing up (the price, picture and set) and adds it; 'waiting' when there is no signal. */
async function lookUp(card: WaitingCard, late = false): Promise<'added' | 'waiting' | 'dropped'> {
  try {
    // No retries here: without signal the card should be saved as waiting at once, not after a minute of backoff.
    const [printing] = await queryClient.fetchQuery({
      ...printingsByArtworkQuery(card.oracleId, card.illustrationId),
      retry: false,
    });
    if (printing === undefined) throw new Error('no printing');
    addToTray(
      { ...printing, ...card, smallImage: printing.smallImage ?? printing.image, finishes: printing.finishes as Finish[] },
      late,
    );
    return 'added';
  } catch (error) {
    // No signal, a timeout, rate limiting, a server hiccup, or the cache cleared mid-request (signing in or out): try
    // again later. Only a card the catalogue has no printing for is dropped.
    const status = error instanceof ApiError ? error.status : null;
    if (isCancelledError(error) || status === 0 || status === 408 || status === 429 || (status ?? 0) >= 500) {
      return 'waiting';
    }
    console.warn(`tray: no printing for ${card.name}`, error);
    return 'dropped';
  }
}

/**
 * Starts looking a card up as soon as the recognizer first names it, a few frames before the scanner is sure: by the
 * time it is, the printing and its pictures are usually on the phone, and it flies in with its own picture.
 */
export function preloadScan(card: Omit<WaitingCard, 'name'>) {
  const query = printingsByArtworkQuery(card.oracleId, card.illustrationId);
  // Once per card, not on every frame: skipped while it is being looked up or once it has been.
  const state = queryClient.getQueryState(query.queryKey);
  if (state?.data !== undefined || state?.fetchStatus === 'fetching') return;
  queryClient
    .fetchQuery({ ...query, retry: false }) // scanToTray shares this request, and must hear "no signal" at once
    .then(([printing]) => {
      const pictures = [printing?.smallImage, printing?.image].filter((uri) => uri != null);
      if (pictures.length > 0) void Image.prefetch(pictures);
    })
    .catch(() => {}); // scanToTray tries again, and keeps the card if there is no signal
}

/** A recognized card goes in the tray; without signal it waits (also across restarts). True once it is in. */
export async function scanToTray(card: WaitingCard): Promise<boolean> {
  const result = await lookUp(card);
  if (result === 'waiting') setWaiting([...waiting, card]);
  return result === 'added';
}

// ponytail: polls every 10 s instead of listening for the connection (no NetInfo here); add expo-network if this
// ever shows up in battery use.
let retrying = false;
const retry = globalThis as { deckinoTrayRetry?: ReturnType<typeof setInterval> };
clearInterval(retry.deckinoTrayRetry); // Fast Refresh re-runs this module; one loop is enough
retry.deckinoTrayRetry = setInterval(async () => {
  if (retrying || waiting.length === 0) return;
  retrying = true;
  try {
    for (const card of waiting) {
      // Each card on its own, so one the server keeps failing on doesn't hold the others back.
      if ((await lookUp(card, true)) !== 'waiting') setWaiting(waiting.filter((other) => other !== card));
    }
  } finally {
    retrying = false;
  }
}, 10000);

/** The + and − on the tray: one copy more or fewer of the last card (never below one; the tray screen removes it). */
export function stepLast(by: 1 | -1) {
  const last = tray.at(-1);
  if (last) changeTrayCard(last.key, { copies: Math.min(99, Math.max(1, last.copies + by)) });
}

export function changeTrayCard(key: string, change: Partial<TrayCard>) {
  set(tray.map((card) => (card.key === key ? { ...card, ...change } : card)));
}

/** Takes a card out of the tray, quietly: nothing is saved yet, and scanning it again puts it back. */
export function removeFromTray(key: string) {
  set(tray.filter((card) => card.key !== key));
}

export function clearTray() {
  set([]);
}

export const trayCount = (cards: TrayCard[]) => cards.reduce((sum, card) => sum + card.copies, 0);

let saving = false;

/** Where the tray goes: a binder, a deck's main deck (A6: no condition or language) or the wishlist (A7: printings only). */
export interface TrayTarget {
  kind: 'binder' | 'deck' | 'wishlist';
  id: string; // '' for the wishlist
  name: string;
}

/** Adds the whole tray in one request, then empties it. Undo takes the cards out and puts the tray back. */
export async function saveTray(target: TrayTarget): Promise<boolean> {
  if (saving || tray.length === 0) return false;
  saving = true;
  const cards = tray;
  const entries = cards.map((card) => ({ scryfallId: card.printing.id, quantity: card.copies, finish: valuesOf(card).finish }));
  let added: string[] = [];
  let applied: WishlistChange[] = [];
  try {
    const saved = await attempt(async () => {
      try {
        if (target.kind === 'wishlist') {
          applied = await changeWishlist(entries.map(({ scryfallId, quantity }) => ({ scryfallId, quantity })));
        } else if (target.kind === 'deck') {
          await changeDeck(target.id, (s) => ({ cards: { ...s, mainboard: entries.reduce(putEntry, s.mainboard) } }));
        } else {
          added = await addCards(
            target.id,
            cards.map((card) => ({
              card: { scryfallId: card.printing.id, ...valuesOf(card), printingConfirmed: card.confirmed },
              copies: card.copies,
            })),
          );
        }
      } catch (error) {
        // Deleted elsewhere (the website): forget it, so the button asks where next time.
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        setPreferences(target.kind === 'deck' ? { scanTo: null } : { defaultBinderId: null });
        throw new Error(`${target.name} is gone. Choose where to add the cards.`);
      }
    });
    if (!saved) return false;
    set(tray.filter((card) => !cards.includes(card))); // anything scanned meanwhile stays
    showToast({
      message: `Added ${cardCount(trayCount(cards))} to ${target.name}`,
      onPress: () =>
        router.push(
          target.kind === 'wishlist'
            ? '/wishlist'
            : target.kind === 'deck'
              ? { pathname: '/deck/[id]', params: { id: target.id } }
              : { pathname: '/binder/[id]', params: { id: target.id } },
        ),
      undo: () =>
        void attempt(async () => {
          if (target.kind === 'wishlist') {
            await undoWishlist(applied);
          } else if (target.kind === 'deck') {
            await changeDeck(target.id, (s) => ({ cards: { ...s, mainboard: entries.reduce(takeEntry, s.mainboard) } }));
          } else {
            await removeCards(target.id, added);
          }
          set([...cards, ...tray]);
        }),
    });
    return true;
  } finally {
    saving = false;
  }
}
