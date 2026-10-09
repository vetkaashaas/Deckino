// Shapes returned by Deckino.Api/Catalogue/CardEndpoints.cs.

export interface CardSummary {
  id: string
  name: string
  manaCost: string | null
  manaValue: number
  typeLine: string | null
  setCode: string
  setName: string
  rarity: string
  image: string | null
  smallImage: string | null // 146px wide: for thumbnails
  usd: number | null
  eur: number | null
}

export interface CardSearchResult {
  cards: CardSummary[]
  hasMore: boolean
}

export interface CardFace {
  name: string
  manaCost: string | null
  typeLine: string | null
  oracleText: string | null
  flavorText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
}

export interface Printing {
  id: string
  setCode: string
  setName: string
  collectorNumber: string
  releasedAt: string
  lang: string
  usd: number | null
  eur: number | null
  isDefault: boolean
  image: string | null // front face, normal size; only from /api/cards/{id}/printings
}

export interface CardDetail extends CardFace {
  id: string
  oracleId: string
  manaValue: number
  colors: string[]
  colorIdentity: string[]
  setCode: string
  setName: string
  collectorNumber: string
  rarity: string
  artist: string | null
  releasedAt: string
  lang: string
  finishes: string[]
  image: string | null // front face, normal size
  smallImage: string | null // front face, 146px wide: for thumbnails
  images: string[] // every face, large
  artCrop: string | null
  faces: CardFace[]
  prices: { usd: number | null; usdFoil: number | null; usdEtched: number | null; eur: number | null; eurFoil: number | null }
  singletonCopies: number | null // copies a Commander deck may hold: 1, the card's own "up to N", or null for any number
  canBeCommander: boolean
  printings: Printing[]
}

export interface CardSet {
  code: string
  name: string
}

export const printingLabel = (p: { setName: string; setCode: string; collectorNumber: string }) =>
  `${p.setName} (${p.setCode.toUpperCase()}) #${p.collectorNumber}`
