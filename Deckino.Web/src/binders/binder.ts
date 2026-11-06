// Shapes returned by Deckino.Api/Binders/BinderEndpoints.cs (generated.ts), and how binder pages show physical cards.
import { useRemembered } from '../components/useRemembered'
import type * as Api from '../generated'

export type Condition = Api.Condition

export const conditions: { value: Condition; label: string }[] = [
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

export type BinderSummary = Api.BinderSummary // value: in the currency asked for (?currency=), USD by default
export type BinderCard = Api.BinderCardDetail // printingConfirmed false: scanned in the app, and nobody has checked the printing yet
export type BinderDetail = Api.BinderDetail
export type PublicBinderCard = Api.PublicBinderCard
export type PublicBinder = Api.PublicBinder

// Identical physical cards (same printing, finish, condition, language and notes) shown as one row with a count.
export interface CardGroup {
  key: string
  copies: BinderCard[]
}

export function groupCopies(cards: BinderCard[]): CardGroup[] {
  const groups = new Map<string, BinderCard[]>()
  for (const c of cards) {
    const key = [c.scryfallId, c.finish, c.condition, c.language, c.notes ?? '', c.printingConfirmed].join('|')
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  return [...groups]
    .map(([key, copies]) => ({ key, copies }))
    .sort((a, b) => a.copies[0].card.name.localeCompare(b.copies[0].card.name) || a.key.localeCompare(b.key))
}

// What cards added to a binder start as (set on the Account page, remembered in this browser), as the app's
// Preferences: most cards are Near Mint English, and the card panel changes any one.
export const useDefaultCondition = () => useRemembered<Condition>('deckino.condition', conditions.map((c) => c.value), 'NM')
export const useDefaultLanguage = () => useRemembered<string>('deckino.language', languages.map((l) => l.value), 'en')

export { printingLabel } from '../cards/api'
