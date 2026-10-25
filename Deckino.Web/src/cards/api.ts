// Shapes returned by Deckino.Api/Catalogue/CardEndpoints.cs (generated.ts: npm run gen:api).
import type * as Api from '../generated'

export type CardSummary = Api.CardSummary // smallImage: 146px wide, for thumbnails
export type CardSearchResult = Api.CardSearchResult
export type CardFace = Api.CardFaceDetail
export type Printing = Api.PrintingSummary // image etc.: only from /api/cards/{id}/printings
// images: every face, large. singletonCopies: copies a Commander deck may hold (1, the card's own "up to N", or null
// for any number).
export type CardDetail = Api.CardDetail

export interface CardSet {
  code: string
  name: string
}

export const printingLabel = (p: { setName: string; setCode: string; collectorNumber: string }) =>
  `${p.setName} (${p.setCode.toUpperCase()}) #${p.collectorNumber}`
