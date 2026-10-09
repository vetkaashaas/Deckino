import { useEffect, useState } from 'react'
import { getJson } from '../api'
import type { CardSearchResult, CardSummary } from '../cards/api'
import { CardImage } from '../components/CardImage'
import { formatPrice } from '../components/currency'
import { ManaSymbols } from '../components/ManaSymbols'
import classes from './Landing.module.css'

// The landing page's previews are real: cards and prices from Deckino's own catalogue, drawn the way the site
// draws them. Whatever the catalogue lacks (a test catalogue has few cards) is simply left out.

const staples = ['Sol Ring', 'Arcane Signet', 'Command Tower', 'Swords to Plowshares', 'Cultivate', 'Lightning Greaves', 'Counterspell']

async function named(name: string) {
  const { cards } = await getJson<CardSearchResult>(`/api/cards?q=${encodeURIComponent(name)}`)
  return cards.find((c) => c.name === name && c.image) ?? null
}

// Loaded once per visit and shared by the previews.
let showcase: Promise<{ staples: CardSummary[]; valuable: CardSummary[] }> | undefined
function loadShowcase() {
  showcase ??= Promise.all([
    Promise.all(staples.map((n) => named(n).catch(() => null))),
    getJson<CardSearchResult>('/api/cards?sort=price').then((r) => r.cards.filter((c) => c.image && c.usd)),
  ]).then(([found, valuable]) => ({ staples: found.filter((c): c is CardSummary => c !== null), valuable }))
  showcase.catch(() => (showcase = undefined))
  return showcase
}

function useShowcase() {
  const [data, setData] = useState<{ staples: CardSummary[]; valuable: CardSummary[] }>()
  useEffect(() => {
    let current = true
    loadShowcase()
      .then((d) => current && setData(d))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [])
  return data
}

// A deck as the builder shows it: stacked by type, with its curve.
export function DeckPreview() {
  const data = useShowcase()
  const cards = data?.staples ?? []
  const curve = [0, 3, 6, 9, 5, 4, 2, 1]
  return (
    <div className={classes.preview} aria-hidden="true">
      <div className={classes.previewBar}>
        <span className={classes.previewDot} />
        <span className={classes.previewDot} />
        <span className={classes.previewDot} />
      </div>
      <div className={classes.deckPreview}>
        <div className={classes.miniStack}>
          {(cards.length ? cards : Array.from({ length: 6 }, () => null)).slice(0, 6).map((c, i) => (
            <div key={c?.id ?? i} className={classes.miniCard}>
              <CardImage src={c?.image} placeholder={!c} alt="" lazy />
            </div>
          ))}
        </div>
        <div className={classes.miniStats}>
          <span className={classes.miniLabel}>Mana curve</span>
          <div className={classes.miniCurve}>
            {curve.map((n, mv) => (
              <span key={mv} style={{ height: `${(n / 9) * 100}%` }} />
            ))}
          </div>
          <span className={classes.miniLegal}>Legal in Commander</span>
          <ul className={classes.miniList}>
            {cards.slice(0, 4).map((c) => (
              <li key={c.id}>
                <span>1</span>
                <span className={classes.miniName}>{c.name}</span>
                <ManaSymbols text={c.manaCost} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

// A nine-pocket binder page of the catalogue's most valuable cards.
export function BinderPreview() {
  const data = useShowcase()
  const cards = data?.valuable.slice(0, 9) ?? []
  return (
    <div className={classes.binderPage} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => cards[i]).map((c, i) => (
        <div key={c?.id ?? i} className={classes.pocket}>
          <CardImage src={c?.image} placeholder={!c} alt="" foil={i === 4} lazy />
          {c && i % 4 === 0 && <span className={classes.pocketTag}>NM</span>}
        </div>
      ))}
    </div>
  )
}

// Current prices, the way a binder's value adds up.
export function PricePreview() {
  const data = useShowcase()
  const cards = data?.valuable.slice(0, 4) ?? []
  const total = cards.reduce((sum, c) => sum + (c.usd ?? 0), 0)
  return (
    <div className={classes.preview} aria-hidden="true">
      <div className={classes.priceHead}>
        <span className={classes.miniLabel}>Binder value</span>
        <span className={classes.priceTotal}>{formatPrice(total, 'usd')}</span>
      </div>
      <svg className={classes.spark} viewBox="0 0 300 70" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--mantine-color-purple-5)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--mantine-color-purple-5)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M0 52 C30 50 45 40 70 42 S110 30 130 34 S170 20 190 26 S240 10 260 14 S290 6 300 4 L300 70 L0 70 Z" fill="url(#spark-fill)" />
        <path d="M0 52 C30 50 45 40 70 42 S110 30 130 34 S170 20 190 26 S240 10 260 14 S290 6 300 4" fill="none" stroke="var(--mantine-color-purple-4)" strokeWidth="2" />
      </svg>
      <ul className={classes.priceList}>
        {cards.map((c) => (
          <li key={c.id}>
            <img src={c.smallImage ?? c.image!} alt="" loading="lazy" className={classes.priceThumb} />
            <span className={classes.miniName}>{c.name}</span>
            <span className={classes.priceValue}>{formatPrice(c.usd, 'usd')}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
