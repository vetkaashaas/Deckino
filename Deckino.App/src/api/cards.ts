import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { CardPrices } from './binders';
import { getJson } from './client';
import { usePreferences } from '@/preferences';

// Shapes returned by Deckino.Api/Catalogue/CardEndpoints.cs and Prices/PriceEndpoints.cs, as in
// Deckino.Web/src/cards/api.ts.

export interface CardSummary {
  id: string;
  name: string;
  manaCost: string | null;
  manaValue: number;
  typeLine: string | null;
  setCode: string;
  setName: string;
  rarity: string;
  image: string | null;
  smallImage: string | null;
  usd: number | null;
  eur: number | null;
}

interface CardSearchResult {
  cards: CardSummary[];
  hasMore: boolean;
}

export interface CardFace {
  name: string;
  manaCost: string | null;
  typeLine: string | null;
  oracleText: string | null;
  flavorText: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
}

export interface Printing {
  id: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string;
  lang: string;
  usd: number | null;
  eur: number | null;
  isDefault: boolean;
  // Only from /printings and /by-artwork:
  image: string | null;
  smallImage?: string | null; // missing from an API before 2026-10-18
  rarity: string;
  finishes: string[];
  prices: CardPrices;
}

export interface CardDetail extends CardFace {
  id: string;
  oracleId: string;
  manaValue: number;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string;
  artist: string | null;
  releasedAt: string;
  lang: string;
  finishes: string[];
  image: string | null;
  images: string[]; // every face, large
  faces: CardFace[];
  prices: { usd: number | null; usdFoil: number | null; usdEtched: number | null; eur: number | null; eurFoil: number | null };
}

export interface PricePoint {
  date: string;
  usd: number | null;
  usdFoil: number | null;
  eur: number | null;
  eurFoil: number | null;
}

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
    queryFn: ({ pageParam, signal }) => getJson<CardSearchResult>(`/api/cards?${query}&page=${pageParam}`, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _all, page) => (last.hasMore ? page + 1 : undefined),
    enabled,
  });
}

// Switching printing on the card page keeps the page (and the printings strip) until the new printing arrives.
export const useCard = (id: string) =>
  useQuery({
    queryKey: ['card', id],
    queryFn: ({ signal }) => getJson<CardDetail>(`/api/cards/${id}`, signal),
    placeholderData: keepPreviousData,
  });

export const usePrintings = (id: string) =>
  useQuery({
    queryKey: ['printings', id],
    queryFn: ({ signal }) => getJson<Printing[]>(`/api/cards/${id}/printings`, signal),
    placeholderData: keepPreviousData,
    enabled: id !== '',
  });

export const usePriceHistory = (id: string) =>
  useQuery({ queryKey: ['prices', id], queryFn: ({ signal }) => getJson<PricePoint[]>(`/api/cards/${id}/prices`, signal) });

/** The printings a scanned card can be, the one to start on first (see CardEndpoints.ByArtworkAsync). */
export const printingsByArtworkQuery = (oracleId: string | null, illustrationId: string | null) => ({
  queryKey: ['by-artwork', oracleId, illustrationId],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    getJson<Printing[]>(
      `/api/cards/by-artwork?oracleId=${oracleId}${illustrationId ? `&illustrationId=${illustrationId}` : ''}`,
      signal,
    ),
  staleTime: Infinity,
});

export const usePrintingsByArtwork = (oracleId: string | null, illustrationId: string | null) =>
  useQuery({ ...printingsByArtworkQuery(oracleId, illustrationId), enabled: oracleId !== null });
