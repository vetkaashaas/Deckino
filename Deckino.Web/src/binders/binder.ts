// Shapes returned by Deckino.Api/Binders/BinderEndpoints.cs, and how binder pages show physical cards.
import type { DeckCard, Finish } from '../decks/deck'

export const conditions = [
  { value: 'NM', label: 'Near Mint' },
  { value: 'LP', label: 'Lightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'HP', label: 'Heavily Played' },
  { value: 'DMG', label: 'Damaged' },
]

// The API's BinderEndpoints.Languages (Scryfall language codes).
export const languages = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ru', label: 'Russian' },
  { value: 'zhs', label: 'Simplified Chinese' },
  { value: 'zht', label: 'Traditional Chinese' },
  { value: 'ph', label: 'Phyrexian' },
]

export const languageLabel = (code: string) => languages.find((l) => l.value === code)?.label ?? code

export interface BinderSummary {
  id: string
  name: string
  isPublic: boolean
  isSelling: boolean
  cardCount: number
  cover: string | null
  updatedAt: string
}

export interface BinderCard {
  id: string
  scryfallId: string
  finish: Finish
  condition: string
  language: string
  notes: string | null
  card: DeckCard
}

export interface BinderDetail {
  id: string
  name: string
  isPublic: boolean
  isSelling: boolean
  createdAt: string
  updatedAt: string
  cards: BinderCard[]
}

export interface PublicBinderCard {
  scryfallId: string
  finish: Finish
  condition: string
  language: string
  count: number
  card: DeckCard
}

export interface PublicBinder {
  id: string
  name: string
  owner: string
  isSelling: boolean
  cards: PublicBinderCard[]
}

// Identical physical cards (same printing, finish, condition, language and notes) shown as one row with a count.
export interface CardGroup {
  key: string
  copies: BinderCard[]
}

export function groupCopies(cards: BinderCard[]): CardGroup[] {
  const groups = new Map<string, BinderCard[]>()
  for (const c of cards) {
    const key = [c.scryfallId, c.finish, c.condition, c.language, c.notes ?? ''].join('|')
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  return [...groups]
    .map(([key, copies]) => ({ key, copies }))
    .sort((a, b) => a.copies[0].card.name.localeCompare(b.copies[0].card.name) || a.key.localeCompare(b.key))
}

export { printingLabel } from '../cards/api'
