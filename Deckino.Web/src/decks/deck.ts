// Shapes returned by Deckino.Api/Decks/DeckEndpoints.cs, and the deck rules the pages share.
import type { CardDetail } from '../cards/api'
import type { Currency } from '../components/currency'

export type Finish = 'nonfoil' | 'foil' | 'etched'
export type SectionName = 'commander' | 'mainboard' | 'sideboard'

// The API's DeckEndpoints.Formats, with their names.
export const formats = [
  { value: 'commander', label: 'Commander' },
  { value: 'standard', label: 'Standard' },
  { value: 'pioneer', label: 'Pioneer' },
  { value: 'modern', label: 'Modern' },
  { value: 'legacy', label: 'Legacy' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'pauper', label: 'Pauper' },
  { value: 'casual', label: 'Casual' },
]

export const formatLabel = (format: string) => formats.find((f) => f.value === format)?.label ?? format

export const finishLabels: Record<Finish, string> = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched' }

export interface DeckCard {
  id: string
  oracleId: string
  name: string
  manaCost: string | null
  manaValue: number
  typeLine: string | null
  colorIdentity: string[]
  setCode: string
  setName: string
  collectorNumber: string
  image: string | null
  artCrop: string | null
  finishes: Finish[]
  prices: CardDetail['prices']
}

export interface DeckEntry {
  scryfallId: string
  quantity: number
  finish: Finish
  card: DeckCard
}

export interface DeckSections {
  commander: DeckEntry[]
  mainboard: DeckEntry[]
  sideboard: DeckEntry[]
}

export interface DeckDetail extends DeckSections {
  id: string
  name: string
  format: string
  isPublic: boolean
  createdAt: string
  updatedAt: string
}

export interface DeckSummary {
  id: string
  name: string
  format: string
  isPublic: boolean
  cardCount: number
  colorIdentity: string[]
  cover: string | null
  updatedAt: string
}

// GET /api/public/decks/{id}: a public deck, its owner's username, and its legality warnings.
export interface PublicDeck {
  deck: DeckDetail
  owner: string
  legality: string[]
}

export interface PublicDeckSearchResult {
  decks: { deck: DeckSummary; owner: string }[]
  hasMore: boolean
}

// The body of POST/PUT /api/decks: entries reference cards by Scryfall ID only.
export function toRequest(deck: { name: string; format: string } & DeckSections) {
  const entries = (list: DeckEntry[]) => list.map(({ scryfallId, quantity, finish }) => ({ scryfallId, quantity, finish }))
  return {
    name: deck.name,
    format: deck.format,
    cards: { commander: entries(deck.commander), mainboard: entries(deck.mainboard), sideboard: entries(deck.sideboard) },
  }
}

// The same fields DeckCard.From gives in the API, for a card added in the page.
export function toDeckCard(card: CardDetail): DeckCard {
  return {
    id: card.id,
    oracleId: card.oracleId,
    name: card.name,
    manaCost: card.manaCost ?? card.faces[0]?.manaCost ?? null,
    manaValue: card.manaValue,
    typeLine: card.typeLine,
    colorIdentity: card.colorIdentity,
    setCode: card.setCode,
    setName: card.setName,
    collectorNumber: card.collectorNumber,
    image: card.image,
    artCrop: card.artCrop,
    finishes: card.finishes as Finish[],
    prices: card.prices,
  }
}

export const defaultFinish = (card: DeckCard): Finish => (card.finishes.includes('nonfoil') ? 'nonfoil' : card.finishes[0])

export const entryKey = (entry: { scryfallId: string; finish: string }) => `${entry.scryfallId}:${entry.finish}`

// Adds an entry to a section, merging it into the entry for the same printing and finish (entries are
// identified by both). Quantities stop at 99, the API's limit.
export function putEntry(entries: DeckEntry[], entry: DeckEntry) {
  const existing = entries.find((e) => entryKey(e) === entryKey(entry))
  if (!existing) return [...entries, entry]
  return entries.map((e) => (e === existing ? { ...e, quantity: Math.min(99, e.quantity + entry.quantity) } : e))
}

export const countCards = (entries: DeckEntry[]) => entries.reduce((sum, e) => sum + e.quantity, 0)

type Prices = Pick<CardDetail['prices'], 'usd' | 'usdFoil' | 'usdEtched' | 'eur' | 'eurFoil'>

// A price in a finish and currency. Every value the site shows goes through here (and PriceEndpoints.Price in the
// API, its server twin), so another price provider plugs in at one place. Scryfall has no EUR price for etched cards.
export function priceOf(p: Prices, finish: Finish, currency: Currency) {
  if (currency === 'eur') return finish === 'nonfoil' ? p.eur : finish === 'foil' ? p.eurFoil : null
  return finish === 'nonfoil' ? p.usd : finish === 'foil' ? p.usdFoil : p.usdEtched
}

// Current Scryfall price of a deck entry or binder card, in its finish.
export const entryPrice = (entry: { finish: Finish; card: { prices: Prices } }, currency: Currency) =>
  priceOf(entry.card.prices, entry.finish, currency)

// A wishlist entry has no finish: the normal price, else foil, else etched.
export const anyFinishPrice = (card: { prices: Prices }, currency: Currency) =>
  priceOf(card.prices, 'nonfoil', currency) ?? priceOf(card.prices, 'foil', currency) ?? priceOf(card.prices, 'etched', currency)

const isLand = (card: DeckCard) => card.typeLine?.includes('Land') === true

// The deck's cover art and colour identity: the commander's, otherwise the first nonland card's art and
// the mainboard's colours. Same rule as DeckSummary.From in the API (for the deck list).
export function deckLook(deck: DeckSections) {
  const cards = (deck.commander.length ? deck.commander : deck.mainboard).map((e) => e.card)
  const cover = deck.commander[0]?.card ?? deck.mainboard.find((e) => !isLand(e.card))?.card ?? deck.mainboard[0]?.card
  const identity = new Set(cards.flatMap((c) => c.colorIdentity))
  return { cover: cover?.artCrop ?? cover?.image ?? null, colors: [...'WUBRG'].filter((c) => identity.has(c)) }
}

// Card-type groups in the order a deck list shows them. A card is in the first group its front face matches,
// trying lands first (so a land creature is a land).
const typeGroups = [
  ['Land', 'Lands'],
  ['Creature', 'Creatures'],
  ['Planeswalker', 'Planeswalkers'],
  ['Battle', 'Battles'],
  ['Instant', 'Instants'],
  ['Sorcery', 'Sorceries'],
  ['Artifact', 'Artifacts'],
  ['Enchantment', 'Enchantments'],
] as const
const groupOrder = ['Creatures', 'Planeswalkers', 'Battles', 'Instants', 'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other']

export function groupByType(entries: DeckEntry[]) {
  const groups = new Map<string, DeckEntry[]>()
  for (const entry of entries) {
    const front = entry.card.typeLine?.split(' // ')[0] ?? ''
    const group = typeGroups.find(([type]) => front.includes(type))?.[1] ?? 'Other'
    groups.set(group, [...(groups.get(group) ?? []), entry])
  }
  return groupOrder
    .filter((g) => groups.has(g))
    .map((g) => ({
      label: g,
      entries: groups.get(g)!.sort((a, b) => a.card.manaValue - b.card.manaValue || a.card.name.localeCompare(b.card.name)),
    }))
}
