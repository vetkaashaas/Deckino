// Shapes returned by Deckino.Api/Decks/DeckEndpoints.cs (generated.ts: npm run gen:api), and the deck rules the pages share.
import type { Currency } from '../components/currency'
import type * as Api from '../generated'
import type { CardDetail } from '../cards/api'
import type { IconName } from '../components/Icon'

export type Finish = Api.Finish
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

export type DeckCard = Api.DeckCard // smallImage: 146px wide, for thumbnails
export type DeckEntry = Api.DeckEntryDetail
export type DeckDetail = Api.DeckDetail
export type DeckSections = Pick<DeckDetail, SectionName>
export type DeckSummary = Api.DeckSummary

// GET /api/public/decks/{id}: a public deck, its owner's username, and its legality warnings.
export type PublicDeck = Api.PublicDeck
export type PublicDeckSearchResult = Api.PublicDeckSearchResult

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
    smallImage: card.smallImage,
    artCrop: card.artCrop,
    finishes: card.finishes,
    prices: card.prices,
    singletonCopies: card.singletonCopies,
    canBeCommander: card.canBeCommander,
    rarity: card.rarity,
    illustrationId: card.illustrationId,
    backImage: card.images.length > 1 ? card.images[1] : null, // a double-faced card's back
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

// Formats where a card normally appears once (DeckLegality's copy limit of 1).
export const isSingleton = (format: string) => format === 'commander'

// The most copies of a card the builder offers in a section: commanders are always one card each; a singleton
// deck offers more only where the card allows it (basic lands, "any number of cards named…"). Legality warns
// about the rest, so other formats keep the API's 1–99.
export function maxCopies(format: string, section: SectionName, card: DeckCard) {
  if (section === 'commander') return 1
  if (isSingleton(format)) return card.singletonCopies ?? 99
  return 99
}

// The copies of an entry's card that count against its limit in a section: the same printing and finish, or in a
// singleton deck any printing of the same card, the commander's included (as DeckLegality counts them; the
// maybeboard isn't checked, so it counts only itself).
export function copiesIn(deck: { format: string } & DeckSections, section: SectionName, entry: DeckEntry) {
  if (!isSingleton(deck.format)) return countCards(deck[section].filter((e) => entryKey(e) === entryKey(entry)))
  const counted = section === 'mainboard' ? [...deck.commander, ...deck.mainboard] : deck[section]
  return countCards(counted.filter((e) => e.card.oracleId === entry.card.oracleId))
}

// What a section is called: in Commander the sideboard is a maybeboard (DeckLegality doesn't check it).
export const sectionLabel = (section: SectionName, format: string) =>
  section === 'commander' ? 'Commander' : section === 'mainboard' ? 'Mainboard' : isSingleton(format) ? 'Maybeboard' : 'Sideboard'

// The size a format's deck aims for, counting the commander: exact for Commander, a minimum elsewhere.
export const targetSize = (format: string) => (format === 'commander' ? 100 : format === 'casual' ? null : 60)

export const countCards = (entries: DeckEntry[]) => entries.reduce((sum, e) => sum + e.quantity, 0)

// The deck as a decklist, in the layout the API's DeckText.Write exports and DeckText.Parse reads back
// (printing and finish included, so it round-trips). A double-faced card goes by its front face.
// "4 Lightning Bolt (2X2) 117 *F*": a decklist line, as Arena, MTGO and the import read it.
export function cardLine(quantity: number, finish: Finish, card: DeckCard) {
  const name = card.backImage ? card.name.split(' // ')[0] : card.name
  const marker = finish === 'foil' ? ' *F*' : finish === 'etched' ? ' *E*' : ''
  return `${quantity} ${name} (${card.setCode.toUpperCase()}) ${card.collectorNumber}${marker}`
}

export function deckText(deck: { format: string } & DeckSections) {
  const sections: [string, DeckEntry[]][] = [
    ['Commander', deck.commander],
    ['Deck', deck.mainboard],
    [sectionLabel('sideboard', deck.format), deck.sideboard],
  ]
  return sections
    .filter(([, entries]) => entries.length > 0)
    .map(([header, entries]) =>
      [
        header,
        ...entries.map(({ quantity, finish, card }) => cardLine(quantity, finish, card)),
      ].join('\n'),
    )
    .join('\n\n')
}

type Prices = Api.CardPrices

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
// What a list of wanted cards costs: each priced as anyFinishPrice, times how many are wanted.
export const wantedValue = (wanted: { quantity: number; card: { prices: Prices } }[] | null | undefined, currency: Currency) =>
  wanted?.reduce((sum, w) => sum + (anyFinishPrice(w.card, currency) ?? 0) * w.quantity, 0) ?? 0

export const anyFinishPrice = (card: { prices: Prices }, currency: Currency) =>
  priceOf(card.prices, 'nonfoil', currency) ?? priceOf(card.prices, 'foil', currency) ?? priceOf(card.prices, 'etched', currency)

export const isLand = (card: DeckCard) => card.typeLine?.includes('Land') === true

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

// The card-type symbol of a type group (and of Lands in every grouping), or of the commander section. Other groups
// and the sideboard have none.
const groupIcons: Record<string, IconName> = {
  Commander: 'type_commander',
  Creatures: 'type_creature',
  Planeswalkers: 'type_planeswalker',
  Battles: 'type_battle',
  Instants: 'type_instant',
  Sorceries: 'type_sorcery',
  Artifacts: 'type_artifact',
  Enchantments: 'type_enchantment',
  Lands: 'type_land',
  Tokens: 'token',
}
export const groupIcon = (label: string): IconName | undefined => groupIcons[label]

// How the list, gallery and stacks views lay out a section: in groups (or none), and the order inside each.
export const groupings = [
  { value: 'type', label: 'Type' },
  { value: 'manaValue', label: 'Mana value' },
  { value: 'color', label: 'Color' },
  { value: 'none', label: 'No groups' },
] as const
// Each sort's two directions, and the one it starts in when chosen (price: dearest first).
export const sortings = [
  { value: 'manaValue', label: 'Mana value', ascending: 'Lowest first', descending: 'Highest first', startDescending: false },
  { value: 'name', label: 'Name', ascending: 'A to Z', descending: 'Z to A', startDescending: false },
  { value: 'price', label: 'Price', ascending: 'Cheapest first', descending: 'Dearest first', startDescending: true },
] as const
export type Grouping = (typeof groupings)[number]['value']
export type Sorting = (typeof sortings)[number]['value']
export interface DeckOrder {
  group: Grouping
  sort: Sorting
  descending: boolean
  currency: Currency // for sorting by price
}

const colorNames: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }

// Each grouping: the group a card is in, and the groups in the order they show. Lands are a group of their own
// in every grouping but none (a land's mana value is 0 and its colors are what it taps for).
// Groups go by a card's front face, so a spell with a land on its back (Khalni Ambush) is a spell.
const frontType = (card: DeckCard) => card.typeLine?.split(' // ')[0] ?? ''
const frontIsLand = (card: DeckCard) => frontType(card).includes('Land')

const groupers: Record<Grouping, { of: (card: DeckCard) => string; order: string[] }> = {
  type: {
    of: (card) => typeGroups.find(([type]) => frontType(card).includes(type))?.[1] ?? 'Other',
    order: groupOrder,
  },
  manaValue: {
    of: (card) => (frontIsLand(card) ? 'Lands' : `${card.manaValue >= 7 ? '7+' : Math.floor(card.manaValue)} mana`),
    order: [...Array.from({ length: 7 }, (_, i) => `${i} mana`), '7+ mana', 'Lands'],
  },
  // By the colored symbols in the mana cost, so a Signet ({2}, but {B}{G} in its text) is colorless. A card with no
  // cost (Ancestral Vision, Living End) goes by its color identity instead.
  color: {
    of: (card) => {
      if (frontIsLand(card)) return 'Lands'
      // Both kinds of two-part card have both parts' costs joined ("{1}{B} // {5}{B}{R}"). A double-faced card (it
      // has a back image) goes by its front face, like the other groupings; a split card (Fire // Ice) is one face
      // showing both halves, so both count. An Adventure or Omen half (Lovestruck Beast's {W}) isn't the card's
      // color: only the main part counts.
      const inset = /Adventure|Omen/.test(card.typeLine?.split(' // ')[1] ?? '')
      const cost = card.backImage || inset ? card.manaCost?.split(' // ')[0] : card.manaCost
      const colors = cost ? [...new Set(cost.match(/[WUBRG]/g))] : card.colorIdentity
      return colors.length === 0 ? 'Colorless' : colors.length > 1 ? 'Multicolor' : (colorNames[colors[0]] ?? 'Colorless')
    },
    order: [...Object.values(colorNames), 'Multicolor', 'Colorless', 'Lands'],
  },
  none: { of: () => '', order: [''] },
}

const byName = (a: DeckEntry, b: DeckEntry) => a.card.name.localeCompare(b.card.name)
const sortKeys: Record<Sorting, (entry: DeckEntry, currency: Currency) => number | string | null> = {
  manaValue: (e) => e.card.manaValue,
  name: (e) => e.card.name,
  price: (e, currency) => entryPrice(e, currency) ?? null,
}

// By the sort's key in its direction, then by name. Cards without a price go last either way.
function comparer({ sort, descending, currency }: DeckOrder) {
  const key = sortKeys[sort]
  return (a: DeckEntry, b: DeckEntry) => {
    const x = key(a, currency)
    const y = key(b, currency)
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1
    const c = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)
    return (descending ? -c : c) || byName(a, b)
  }
}

// A section's cards in groups, each sorted. A group with no label ('') shows without a heading.
function arrange(entries: DeckEntry[], order: DeckOrder) {
  const grouper = groupers[order.group]
  const compare = comparer(order)
  const groups = new Map<string, DeckEntry[]>()
  for (const entry of entries) {
    const label = grouper.of(entry.card)
    groups.set(label, [...(groups.get(label) ?? []), entry])
  }
  return grouper.order
    .filter((g) => groups.has(g))
    .map((g) => ({ label: g, entries: groups.get(g)!.sort(compare) }))
}

// The commander section is never grouped or sorted: one or two cards, in the order the hero (commander[0]) uses.
export const arrangeSection = (section: SectionName, entries: DeckEntry[], order: DeckOrder) =>
  section === 'commander' ? (entries.length ? [{ label: '', entries }] : []) : arrange(entries, order)

const groupByType = (entries: DeckEntry[]) => arrange(entries, { group: 'type', sort: 'manaValue', descending: false, currency: 'usd' })

// Where DeckJumps scrolls to: a section, or one card type in it (the heading of whichever view shows).
// A group's label ("7+ mana") goes in as letters and digits only: an id has no spaces.
export const jumpId = (section: SectionName, type?: string) => (type ? `deck-${section}-${type.replace(/[^A-Za-z0-9]+/g, '-')}` : `deck-${section}`)
export const tokensJumpId = 'deck-tokens'

// The deck at a glance, from the cards that are played (commander and mainboard): the mana curve of its spells
// (7 meaning 7 or more), the coloured mana symbols in their costs, and how many cards of each type.
export function deckStats(deck: DeckSections) {
  const played = [...deck.commander, ...deck.mainboard]
  const spells = played.filter((e) => !isLand(e.card))
  const curve = Array.from({ length: 8 }, () => 0)
  for (const e of spells) curve[Math.min(7, Math.floor(e.card.manaValue))] += e.quantity
  const pips: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  for (const e of played) {
    for (const symbol of e.card.manaCost?.match(/\{[^}]+\}/g) ?? []) {
      // A hybrid symbol ({W/U}) counts half for each colour.
      const colors = symbol.slice(1, -1).split('/').filter((c) => c in pips)
      for (const c of colors) pips[c] += e.quantity / colors.length
    }
  }
  const spellCount = countCards(spells)
  const manaValue = spells.reduce((sum, e) => sum + e.card.manaValue * e.quantity, 0)
  return {
    curve,
    pips,
    types: groupByType(played).map((g) => ({ label: g.label, count: countCards(g.entries) })),
    averageManaValue: spellCount ? manaValue / spellCount : 0,
    lands: countCards(played) - spellCount,
  }
}
