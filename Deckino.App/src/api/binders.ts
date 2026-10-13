import { useQuery } from '@tanstack/react-query';

import { getJson, send } from './client';
import { queryClient } from './query-client';
import { useSignedIn } from './session';

// Shapes returned by Deckino.Api/Binders/BinderEndpoints.cs, as in Deckino.Web/src/binders/binder.ts.

export type Finish = 'nonfoil' | 'foil' | 'etched';
type Currency = 'usd' | 'eur';

export interface CardPrices {
  usd: number | null;
  usdFoil: number | null;
  usdEtched: number | null;
  eur: number | null;
  eurFoil: number | null;
}

/** A printing as the binder endpoints describe it (the API's DeckCard). */
export interface BinderPrinting {
  id: string;
  oracleId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  image: string | null;
  smallImage: string | null;
  finishes: Finish[];
  prices: CardPrices;
  rarity: string;
  illustrationId: string | null;
}

export interface BinderSummary {
  id: string;
  name: string;
  isPublic: boolean;
  isSelling: boolean;
  cardCount: number;
  cover: string | null;
  updatedAt: string;
  value: number; // in the currency asked for
}

export interface BinderCard {
  id: string;
  scryfallId: string;
  finish: Finish;
  condition: string;
  language: string;
  notes: string | null;
  printingConfirmed: boolean; // false: scanned, and nobody has checked the printing yet
  card: BinderPrinting;
}

export interface BinderDetail {
  id: string;
  name: string;
  isPublic: boolean;
  isSelling: boolean;
  cards: BinderCard[];
}

export interface PriceMover {
  card: BinderPrinting;
  finish: Finish;
  count: number;
  change: number;
  percent: number;
}

export interface CollectionPrices {
  currency: Currency;
  value: number;
  weekChange: number;
  movers: PriceMover[];
}

/** What a copy is: the printing and how the user holds it. */
export interface CopyValues {
  scryfallId: string;
  finish: Finish;
  condition: string;
  language: string;
  notes?: string | null; // the website's; the app keeps them as they are
  printingConfirmed?: boolean;
}

export function useBinders(currency: Currency = 'usd') {
  return useQuery({
    queryKey: ['binders', currency],
    queryFn: () => send<BinderSummary[]>('GET', `/api/binders?currency=${currency}`),
    enabled: useSignedIn(),
  });
}

export function useBinder(id: string) {
  return useQuery({ queryKey: ['binder', id], queryFn: ({ signal }) => getJson<BinderDetail>(`/api/binders/${id}`, signal) });
}

export function useCollectionPrices(currency: Currency) {
  return useQuery({
    queryKey: ['collection-prices', currency],
    queryFn: () => send<CollectionPrices>('GET', `/api/collection/prices?currency=${currency}`),
    enabled: useSignedIn(),
  });
}

/** The price of one copy in that finish, as the API's PriceEndpoints.Price. */
export function copyPrice(prices: CardPrices, finish: Finish, currency: Currency): number | null {
  if (currency === 'eur') return finish === 'nonfoil' ? prices.eur : finish === 'foil' ? prices.eurFoil : null;
  return finish === 'nonfoil' ? prices.usd : finish === 'foil' ? prices.usdFoil : prices.usdEtched;
}

/** The finish to add a printing in: the preferred one when it comes in it, else non-foil, else what it has. */
export function finishFor(finishes: string[], preferred: Finish): Finish {
  if (finishes.includes(preferred)) return preferred;
  return (finishes.includes('nonfoil') ? 'nonfoil' : (finishes[0] ?? 'nonfoil')) as Finish;
}

// Identical copies (same printing, finish, condition, language, notes, checked or not) shown as one row with a count.
export interface CardGroup {
  key: string;
  copies: BinderCard[];
}

export function groupCopies(cards: BinderCard[]): CardGroup[] {
  const groups = new Map<string, BinderCard[]>();
  for (const c of cards) {
    const key = [c.scryfallId, c.finish, c.condition, c.language, c.notes ?? '', c.printingConfirmed].join('|');
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups]
    .map(([key, copies]) => ({ key, copies }))
    .sort((a, b) => a.copies[0].card.name.localeCompare(b.copies[0].card.name) || a.key.localeCompare(b.key));
}

// Every change answers with the whole binder: it replaces the cached one, and the lists and totals refetch.
function changed(binder: BinderDetail): BinderDetail {
  queryClient.setQueryData(['binder', binder.id], binder);
  void queryClient.invalidateQueries({ queryKey: ['binders'] });
  void queryClient.invalidateQueries({ queryKey: ['collection-prices'] });
  // What you own changed: the scanner's answers (A7) and decks' comparisons.
  void queryClient.invalidateQueries({ queryKey: ['ownership'] });
  void queryClient.invalidateQueries({ queryKey: ['deck-comparison'] });
  return binder;
}

function forgotten(id: string) {
  queryClient.removeQueries({ queryKey: ['binder', id] });
  void queryClient.invalidateQueries({ queryKey: ['binders'] });
  void queryClient.invalidateQueries({ queryKey: ['collection-prices'] });
}

export async function createBinder(name: string): Promise<BinderDetail> {
  return changed(await send<BinderDetail>('POST', '/api/binders', { body: { name } }));
}

export async function updateBinder(id: string, change: { name?: string; isPublic?: boolean; isSelling?: boolean }) {
  return changed(await send<BinderDetail>('PUT', `/api/binders/${id}`, { body: change }));
}

export async function deleteBinder(id: string): Promise<void> {
  await send('DELETE', `/api/binders/${id}`);
  forgotten(id);
}

/** Adds every line in one request, all or nothing; answers with the new copies' ids (for undo). */
export async function addCards(binderId: string, lines: { card: CopyValues; copies: number }[]): Promise<string[]> {
  const answer = await send<{ binder: BinderDetail; added: string[] }>('POST', `/api/binders/${binderId}/cards/batch`, {
    body: { cards: lines },
  });
  changed(answer.binder);
  return answer.added;
}

export async function removeCards(binderId: string, cardIds: string[]) {
  return changed(await send<BinderDetail>('POST', `/api/binders/${binderId}/cards/remove`, { body: { cardIds } }));
}

/** Saving a copy also marks its printing checked. */
export async function updateCard(binderId: string, cardId: string, values: CopyValues) {
  return changed(await send<BinderDetail>('PUT', `/api/binders/${binderId}/cards/${cardId}`, { body: values }));
}

export async function moveCards(binderId: string, cardIds: string[], toBinderId: string) {
  const binder = changed(
    await send<BinderDetail>('POST', `/api/binders/${binderId}/cards/move`, { body: { cardIds, toBinderId } }),
  );
  void queryClient.invalidateQueries({ queryKey: ['binder', toBinderId] });
  return binder;
}

export const publicBinderUrl = (id: string) => `https://deckino.com/binder/${id}`;

/** Puts removed copies back as they were (undo); they come back with new ids. */
export function restoreCards(binderId: string, copies: BinderCard[]) {
  return addCards(
    binderId,
    copies.map((c) => ({
      card: {
        scryfallId: c.scryfallId,
        finish: c.finish,
        condition: c.condition,
        language: c.language,
        notes: c.notes,
        printingConfirmed: c.printingConfirmed,
      },
      copies: 1,
    })),
  );
}

export const cardCount = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`;
