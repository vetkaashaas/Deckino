// Shapes returned by Deckino.Api/Catalogue/CardEndpoints.cs.

export interface CardSummary {
  id: string
  name: string
  manaCost: string | null
  typeLine: string | null
  setCode: string
  setName: string
  image: string | null
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
  images: string[] // every face, large
  artCrop: string | null
  faces: CardFace[]
  prices: { usd: number | null; usdFoil: number | null; usdEtched: number | null; eur: number | null; eurFoil: number | null }
  printings: Printing[]
}

export interface CardSet {
  code: string
  name: string
}
