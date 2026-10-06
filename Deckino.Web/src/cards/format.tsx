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
  if (value === null) return '—'
  return new Intl.NumberFormat(currency === 'usd' ? 'en-US' : 'de-DE', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(value)
}

export function CurrencyToggle({ currency, onChange }: { currency: Currency; onChange: (c: Currency) => void }) {
  return (
    <div className="toggle" role="group" aria-label="Currency">
      {(['usd', 'eur'] as const).map((c) => (
        <button key={c} type="button" aria-pressed={currency === c} onClick={() => onChange(c)}>
          {c.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// Renders {R}, {2}, {W/U}, {T} etc. as Scryfall's hotlinked symbol images, everything else as text.
export function Symbols({ text }: { text: string | null }) {
  if (!text) return null
  return text.split(/(\{[^}]+\})/).map((part, i) =>
    /^\{[^}]+\}$/.test(part) ? (
      <img
        key={i}
        className="symbol"
        src={`https://svgs.scryfall.io/card-symbols/${part.slice(1, -1).replace('/', '')}.svg`}
        alt={part}
      />
    ) : (
      part
    ),
  )
}
