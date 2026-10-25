import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getJson } from './client';
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

// Switching printing on the card page keeps the page (and the printings strip) until the new printing arrives.
export const useCard = (id: string) =>
  useQuery({
    queryKey: ['card', id],
    queryFn: ({ signal }) => getJson(`/api/cards/${id}`, signal),
    placeholderData: keepPreviousData,
  });

export const usePrintings = (id: string) =>
  useQuery({
    queryKey: ['printings', id],
    queryFn: ({ signal }) => getJson(`/api/cards/${id}/printings`, signal),
    placeholderData: keepPreviousData,
    enabled: id !== '',
  });

export const usePriceHistory = (id: string) =>
  useQuery({ queryKey: ['prices', id], queryFn: ({ signal }) => getJson(`/api/cards/${id}/prices`, signal) });

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
