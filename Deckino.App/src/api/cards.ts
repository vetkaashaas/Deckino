import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getJson } from './client';

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
  image: string | null; // only from /printings and /by-artwork
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

export function useCardSearch(filters: CardFilters) {
  // Without a name, browsing starts with the most valuable cards, as on the website.
  const sort = filters.sort || (filters.q ? 'name' : 'price');
  const query = Object.entries({ ...filters, sort })
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return useInfiniteQuery({
    queryKey: ['cards', query],
    queryFn: ({ pageParam, signal }) => getJson<CardSearchResult>(`/api/cards?${query}&page=${pageParam}`, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _all, page) => (last.hasMore ? page + 1 : undefined),
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
  });

export const usePriceHistory = (id: string) =>
  useQuery({ queryKey: ['prices', id], queryFn: ({ signal }) => getJson<PricePoint[]>(`/api/cards/${id}/prices`, signal) });

/** The printings a scanned card can be, the one to start on first (see CardEndpoints.ByArtworkAsync). */
export const usePrintingsByArtwork = (oracleId: string | null, illustrationId: string | null) =>
  useQuery({
    queryKey: ['by-artwork', oracleId, illustrationId],
    queryFn: ({ signal }) =>
      getJson<Printing[]>(
        `/api/cards/by-artwork?oracleId=${oracleId}${illustrationId ? `&illustrationId=${illustrationId}` : ''}`,
        signal,
      ),
    enabled: oracleId !== null,
    staleTime: Infinity,
  });
