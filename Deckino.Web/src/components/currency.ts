import { useState } from 'react'

export type Currency = 'usd' | 'eur'

const currencyKey = 'deckino.currency'

// USD by default; the choice is remembered in this browser.
export function useCurrency() {
  const [currency, setCurrency] = useState<Currency>(() => {
    try {
      return localStorage.getItem(currencyKey) === 'eur' ? 'eur' : 'usd'
    } catch {
      return 'usd'
    }
  })
  const choose = (next: Currency) => {
    setCurrency(next)
    try {
      localStorage.setItem(currencyKey, next)
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
  }
  return [currency, choose] as const
}

export function formatPrice(value: number | null, currency: Currency) {
  if (value === null) return 'No price'
  return new Intl.NumberFormat(currency === 'usd' ? 'en-US' : 'de-DE', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(value)
}
