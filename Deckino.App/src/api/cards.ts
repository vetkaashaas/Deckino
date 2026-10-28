import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';

import { getJson } from './client';
import { queryClient } from './query-client';
import type * as Api from './generated';
import { usePreferences } from '@/preferences';

// Shapes returned by Deckino.Api/Catalogue/CardEndpoints.cs and Prices/PriceEndpoints.cs (generated.ts).

export type CardSummary = Api.CardSummary;
export type CardFace = Api.CardFaceDetail;
/** A printing from /printings and /by-artwork, with what CardDetail's printings leave out. */
export type Printing = Api.PrintingDetail;
export type CardDetail = Api.CardDetail; // images: every face, large
export type PricePoint = Api.PricePoint;

export interface CardFilters {
  q: string;
  colors: string; // e.g. "WU", "C" for colourless
  mv: string; // "7" means 7 or more
  rarity: string;
  type: string;
  sort: string; // name, price, mv, newest
}

export const noFilters: CardFilters = { q: '', colors: '', mv: '', rarity: '', type: '', sort: '' };

/** The sort when none is chosen: best match for a name, else the newest cards first. */
export const defaultSort = (q: string) => (q ? 'name' : 'newest');

export function useCardSearch(filters: CardFilters, enabled = true) {
  const { currency } = usePreferences(); // what Most valuable sorts by
  const sort = filters.sort || defaultSort(filters.q);
  const query = Object.entries({ ...filters, sort, currency })
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return useInfiniteQuery({
    queryKey: ['cards', query],
    queryFn: ({ pageParam, signal }) => getJson(`/api/cards?${query}&page=${pageParam}`, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _all, page) => (last.hasMore ? page + 1 : undefined),
    enabled,
  });
}

// Switching printing on the card page keeps the page (and its carousel) until the new printing arrives.
export const useCard = (id: string) => useQuery({ ...cardQuery(id), placeholderData: keepPreviousData });

const cardQuery = (id: string) => ({
  queryKey: ['card', id],
  queryFn: ({ signal }: { signal: AbortSignal }) => getJson(`/api/cards/${id}`, signal),
});
const priceQuery = (id: string) => ({
  queryKey: ['prices', id],
  queryFn: ({ signal }: { signal: AbortSignal }) => getJson(`/api/cards/${id}/prices`, signal),
});

export const usePrintings = (id: string) =>
  useQuery({
    queryKey: ['printings', id],
    queryFn: ({ signal }) => getJson(`/api/cards/${id}/printings`, signal),
    placeholderData: keepPreviousData,
    enabled: id !== '',
  });

export const usePriceHistory = (id: string) => useQuery(priceQuery(id));

/**
 * Loads a printing's page ahead (the card page's carousel, for its neighbours), so landing on it shows it at once.
 * `printings` is the card's list, the same for each of its printings.
 */
export function prefetchPrinting(id: string, printings: Printing[]) {
  // Its sharper pictures too, which the carousel swaps in on landing.
  queryClient
    .fetchQuery(cardQuery(id))
    .then((card) => Image.prefetch(card.images))
    .catch(() => {}); // only a head start: the page loads it again if this failed
  void queryClient.prefetchQuery(priceQuery(id));
  if (!queryClient.getQueryData(['printings', id])) queryClient.setQueryData(['printings', id], printings);
}

/** The printings a scanned card can be, the one to start on first (see CardEndpoints.ByArtworkAsync). */
export const printingsByArtworkQuery = (oracleId: string | null, illustrationId: string | null) => ({
  queryKey: ['by-artwork', oracleId, illustrationId],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    getJson(
      `/api/cards/by-artwork?oracleId=${oracleId}${illustrationId ? `&illustrationId=${illustrationId}` : ''}`,
      signal,
    ),
  staleTime: Infinity,
});

export const usePrintingsByArtwork = (oracleId: string | null, illustrationId: string | null) =>
  useQuery({ ...printingsByArtworkQuery(oracleId, illustrationId), enabled: oracleId !== null });

/** The file name of a set's symbol (svgs.scryfall.io/sets/<icon>.svg), often not its code: plst's is "planeswalker". */
export function useSetIcon(setCode: string) {
  const icons = useQuery({
    queryKey: ['set-icons'],
    queryFn: async ({ signal }) => {
      const sets = await getJson('/api/sets', signal);
      return Object.fromEntries(sets.flatMap((s) => (s.icon ? [[s.code, s.icon]] : [])));
    },
    staleTime: Infinity,
  });
  return icons.data?.[setCode];
}
