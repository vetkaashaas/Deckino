import { useRemembered } from './useRemembered'

export type Currency = 'usd' | 'eur'

// USD by default; the choice is remembered in this browser.
export const useCurrency = () => useRemembered<Currency>('deckino.currency', ['usd', 'eur'], 'usd')

export function formatPrice(value: number | null, currency: Currency) {
  if (value === null) return 'No price'
  return new Intl.NumberFormat(currency === 'usd' ? 'en-US' : 'de-DE', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(value)
}
