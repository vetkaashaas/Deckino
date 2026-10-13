import { useQuery } from '@tanstack/react-query';

import { copyPrice, type BinderPrinting, type Finish } from './binders';
import { getJson, send } from './client';
import { queryClient } from './query-client';
import { useSignedIn } from './session';
import { getPreferences, setPreferences } from '@/preferences';

// Shapes returned by Deckino.Api/Decks/DeckEndpoints.cs and the deck rules, as in Deckino.Web/src/decks/deck.ts.

export type SectionName = 'commander' | 'mainboard' | 'sideboard';

export const FORMATS = [
  { value: 'commander', label: 'Commander' },
  { value: 'standard', label: 'Standard' },
  { value: 'pioneer', label: 'Pioneer' },
  { value: 'modern', label: 'Modern' },
  { value: 'legacy', label: 'Legacy' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'pauper', label: 'Pauper' },
  { value: 'casual', label: 'Casual' },
] as const;

export const formatLabel = (format: string) => FORMATS.find((f) => f.value === format)?.label ?? format;

/** A printing as the deck endpoints describe it (the API's DeckCard). */
export interface DeckCard extends BinderPrinting {
  manaCost: string | null;
  manaValue: number;
  typeLine: string | null;
  colorIdentity: string[];
  artCrop: string | null;
  singletonCopies: number | null;
  canBeCommander: boolean;
}

export interface DeckEntry {
  scryfallId: string;
  quantity: number;
  finish: Finish;
  card: DeckCard;
}

export interface DeckSections {
  commander: DeckEntry[];
  mainboard: DeckEntry[];
  sideboard: DeckEntry[];
}

export interface DeckDetail extends DeckSections {
  id: string;
  name: string;
  format: string;
  isPublic: boolean;
  updatedAt: string;
}

export interface DeckSummary {
  id: string;
  name: string;
  format: string;
  isPublic: boolean;
  cardCount: number;
  colorIdentity: string[];
  cover: string | null;
  updatedAt: string;
}

/** An entry as the API takes it: the card by id only. */
export interface EntryRequest {
  scryfallId: string;
  quantity: number;
  finish: Finish;
}
export type Sections = Record<SectionName, EntryRequest[]>;

export const SECTIONS: SectionName[] = ['commander', 'mainboard', 'sideboard'];

export function useDecks(enabled = true) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: ['decks'], queryFn: () => send<DeckSummary[]>('GET', '/api/decks'), enabled: signedIn && enabled });
}

export function useDeck(id: string) {
  return useQuery({ queryKey: ['deck', id], queryFn: ({ signal }) => getJson<DeckDetail>(`/api/decks/${id}`, signal) });
}

/** What breaks the format's rules, in plain words from the API (an empty list: legal). */
export function useLegality(deck: DeckDetail | undefined) {
  return useQuery({
    queryKey: ['legality', deck?.id, deck?.updatedAt],
    queryFn: () => send<string[]>('POST', '/api/decks/legality', { body: toRequest(deck!) }),
    enabled: deck !== undefined,
    // The last answer stays up while a change to the same deck is checked.
    placeholderData: (last, lastQuery) => (lastQuery?.queryKey[1] === deck?.id ? last : undefined),
  });
}

const entries = (list: DeckEntry[]): EntryRequest[] =>
  list.map(({ scryfallId, quantity, finish }) => ({ scryfallId, quantity, finish }));

export function sectionsOf(deck: DeckSections): Sections {
  return { commander: entries(deck.commander), mainboard: entries(deck.mainboard), sideboard: entries(deck.sideboard) };
}

const toRequest = (deck: DeckDetail, cards: Sections = sectionsOf(deck)) => ({ name: deck.name, format: deck.format, cards });

function changed(deck: DeckDetail): DeckDetail {
  queryClient.setQueryData(['deck', deck.id], deck);
  void queryClient.invalidateQueries({ queryKey: ['decks'] });
  return deck;
}

export async function createDeck(name: string, format: string): Promise<DeckDetail> {
  const empty = { commander: [], mainboard: [], sideboard: [] };
  return changed(await send<DeckDetail>('POST', '/api/decks', { body: { name, format, cards: empty } }));
}

export async function deleteDeck(id: string): Promise<void> {
  await send('DELETE', `/api/decks/${id}`);
  if (getPreferences().scanDeckId === id) setPreferences({ scanDeckId: null }); // scans go to the binder again
  queryClient.removeQueries({ queryKey: ['deck', id] });
  void queryClient.invalidateQueries({ queryKey: ['decks'] });
}

export async function setDeckPublic(id: string, isPublic: boolean) {
  return changed(await send<DeckDetail>('PUT', `/api/decks/${id}/visibility`, { body: { isPublic } }));
}

// The API saves a whole deck at a time. Changes go one after another, each made to the deck as the last save left
// it, so quick taps can't undo each other.
const queues = new Map<string, Promise<unknown>>();

export function changeDeck(
  id: string,
  change: (cards: Sections, deck: DeckDetail) => { cards?: Sections; name?: string; format?: string },
): Promise<DeckDetail> {
  const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    // The cached deck when it's recent (as the last save left it), else the saved one: it may have changed on the website.
    const deck = await queryClient.fetchQuery({
      queryKey: ['deck', id],
      queryFn: () => getJson<DeckDetail>(`/api/decks/${id}`),
      staleTime: 30_000,
    });
    const body = { ...toRequest(deck), ...change(sectionsOf(deck), deck) };
    return changed(await send<DeckDetail>('PUT', `/api/decks/${id}`, { body }));
  });
  queues.set(id, run);
  return run;
}

/** Adds copies to a section, joining the entry for the same printing and finish (99 at most, the API's limit). */
export function putEntry(list: EntryRequest[], entry: EntryRequest): EntryRequest[] {
  const same = list.find((e) => e.scryfallId === entry.scryfallId && e.finish === entry.finish);
  if (!same) return [...list, entry];
  return list.map((e) => (e === same ? { ...e, quantity: Math.min(99, e.quantity + entry.quantity) } : e));
}

/** Takes copies away again (the undo of putEntry); the entry goes when none are left. */
export function takeEntry(list: EntryRequest[], entry: EntryRequest): EntryRequest[] {
  return list
    .map((e) => (e.scryfallId === entry.scryfallId && e.finish === entry.finish ? { ...e, quantity: e.quantity - entry.quantity } : e))
    .filter((e) => e.quantity > 0);
}

/** In Commander the sideboard is a maybeboard (its cards aren't checked). */
export const sectionLabel = (section: SectionName, format: string) =>
  section === 'commander' ? 'Commander' : section === 'mainboard' ? 'Main deck' : format === 'commander' ? 'Maybeboard' : 'Sideboard';

export const countCards = (list: { quantity: number }[]) => list.reduce((sum, e) => sum + e.quantity, 0);

/** The played cards: commander and main deck. */
export const playedCount = (deck: DeckSections) => countCards(deck.commander) + countCards(deck.mainboard);

export function deckValue(deck: DeckSections, currency: 'usd' | 'eur') {
  return [...deck.commander, ...deck.mainboard].reduce(
    (sum, e) => sum + (copyPrice(e.card.prices, e.finish, currency) ?? 0) * e.quantity,
    0,
  );
}

/** The cover art: the commander's, else the first nonland card's. Same rule as DeckSummary.From in the API. */
export function deckCover(deck: DeckSections) {
  const card =
    deck.commander[0]?.card ?? deck.mainboard.find((e) => !e.card.typeLine?.includes('Land'))?.card ?? deck.mainboard[0]?.card;
  return card?.artCrop ?? card?.image ?? null;
}

// Card-type groups in deck-list order. A card goes in the first group its front face matches, lands first.
const TYPE_GROUPS = [
  ['Land', 'Lands'],
  ['Creature', 'Creatures'],
  ['Planeswalker', 'Planeswalkers'],
  ['Battle', 'Battles'],
  ['Instant', 'Instants'],
  ['Sorcery', 'Sorceries'],
  ['Artifact', 'Artifacts'],
  ['Enchantment', 'Enchantments'],
] as const;
const GROUP_ORDER = ['Creatures', 'Planeswalkers', 'Battles', 'Instants', 'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other'];

export function groupByType(list: DeckEntry[]) {
  const groups = new Map<string, DeckEntry[]>();
  for (const entry of list) {
    const front = entry.card.typeLine?.split(' // ')[0] ?? '';
    const group = TYPE_GROUPS.find(([type]) => front.includes(type))?.[1] ?? 'Other';
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  return GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({
    label: g,
    entries: groups.get(g)!.sort((a, b) => a.card.manaValue - b.card.manaValue || a.card.name.localeCompare(b.card.name)),
  }));
}

export const publicDeckUrl = (id: string) => `https://deckino.com/deck/${id}`;
