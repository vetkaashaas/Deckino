import { useQuery } from '@tanstack/react-query';

import { copyPrice, finishFor } from './binders';
import { getJson, send } from './client';
import type { DeckCard } from './decks';
import { queryClient } from './query-client';
import { useSignedIn } from './session';

// The wishlist and "do I own this?" (AppPlan, Phase A7), from Deckino.Api/Wishlist/WishlistEndpoints.cs.

export interface WishlistEntry {
  id: string;
  scryfallId: string;
  quantity: number;
  card: DeckCard;
}

/** Copies to add (or, negative, take away) of a printing. */
export interface WishlistChange {
  scryfallId: string;
  quantity: number;
}

/** For one card (any printing): copies in your binders, copies on your wishlist, and your decks that play it. */
export interface Ownership {
  oracleId: string;
  owned: number;
  wanted: number;
  decks: { id: string; name: string }[];
}

export interface DeckComparison {
  owned: number;
  missing: number;
}

export function useWishlist() {
  return useQuery({ queryKey: ['wishlist'], queryFn: ({ signal }) => getJson<WishlistEntry[]>('/api/wishlist', signal), enabled: useSignedIn() });
}

/** What you have of a card, for the scanner. Signed out: nothing to ask. */
export function useOwnership(oracleId: string | null) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['ownership', oracleId],
    queryFn: async () => (await send<Ownership[]>('POST', '/api/collection/lookup', { body: { oracleIds: [oracleId] } }))[0],
    enabled: signedIn && oracleId !== null,
    staleTime: 30_000,
  });
}

/** How much of a deck's cards are in your binders. Keyed by the deck's last save, so a change asks again. */
export function useDeckComparison(deck: { id: string; updatedAt: string } | undefined) {
  return useQuery({
    queryKey: ['deck-comparison', deck?.id, deck?.updatedAt],
    queryFn: ({ signal }) => getJson<DeckComparison>(`/api/decks/${deck!.id}/collection`, signal),
    enabled: deck !== undefined,
  });
}

/** What you own and want changed: the scanner's answers and decks' comparisons are asked again. */
export function ownershipChanged() {
  void queryClient.invalidateQueries({ queryKey: ['ownership'] });
  void queryClient.invalidateQueries({ queryKey: ['deck-comparison'] });
}

function changed(list: WishlistEntry[]) {
  queryClient.setQueryData(['wishlist'], list);
  ownershipChanged();
}

/** Adds (or takes away) copies of several printings at once. Answers what really changed, for the undo. */
export async function changeWishlist(changes: WishlistChange[]): Promise<WishlistChange[]> {
  const result = await send<{ cards: WishlistEntry[]; applied: WishlistChange[] }>('POST', '/api/wishlist/batch', {
    body: { cards: changes },
  });
  changed(result.cards);
  return result.applied;
}

/** Puts back what changeWishlist (or Add missing) did. */
export const undoWishlist = (applied: WishlistChange[]) =>
  changeWishlist(applied.map((c) => ({ scryfallId: c.scryfallId, quantity: -c.quantity })));

export async function updateWanted(id: string, values: { scryfallId: string; quantity: number }) {
  changed(await send<WishlistEntry[]>('PUT', `/api/wishlist/${id}`, { body: values }));
}

export async function removeWanted(id: string) {
  changed(await send<WishlistEntry[]>('DELETE', `/api/wishlist/${id}`));
}

/** Puts a deck's missing cards on the wishlist (each as often as it's missing; twice changes nothing). */
export async function addMissing(deckId: string) {
  const result = await send<{ added: number; changes: WishlistChange[] }>('POST', `/api/decks/${deckId}/collection/wishlist`);
  void queryClient.invalidateQueries({ queryKey: ['wishlist'] });
  ownershipChanged();
  return result;
}

/** A wanted card's price: the cheapest way to get it is usually non-foil. */
export const wantedPrice = (card: DeckCard, currency: 'usd' | 'eur') => copyPrice(card.prices, finishFor(card.finishes, 'nonfoil'), currency);

export const wishlistValue = (list: WishlistEntry[], currency: 'usd' | 'eur') =>
  list.reduce((sum, e) => sum + (wantedPrice(e.card, currency) ?? 0) * e.quantity, 0);
