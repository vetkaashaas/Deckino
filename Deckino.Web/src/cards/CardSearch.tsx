import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { getJson, type CardSearchResult, type CardSet } from './api'
import { CurrencyToggle, formatPrice, useCurrency } from './format'

const colorOptions = [
  ['W', 'White'],
  ['U', 'Blue'],
  ['B', 'Black'],
  ['R', 'Red'],
  ['G', 'Green'],
  ['C', 'Colorless'],
] as const

// The search lives in the URL (?q=&colors=&type=&set=&extras=), so results can be linked and go back works.
export default function CardSearch() {
  const [params, setParams] = useSearchParams()
  const query = params.toString()
  const [currency, setCurrency] = useCurrency()
  const [sets, setSets] = useState<CardSet[]>([])
  const [result, setResult] = useState<CardSearchResult & { page: number; query: string }>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    getJson<CardSet[]>('/api/sets')
      .then(setSets)
      .catch(() => setSets([]))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    getJson<CardSearchResult>(`/api/cards?${query}`, controller.signal)
      .then((r) => {
        setFailed(false)
        setResult({ ...r, page: 1, query })
      })
      .catch(() => !controller.signal.aborted && setFailed(true))
    return () => controller.abort()
  }, [query])

  async function loadMore() {
    if (!result) return
    const page = result.page + 1
    const next = new URLSearchParams(params)
    next.set('page', String(page))
    const more = await getJson<CardSearchResult>(`/api/cards?${next}`)
    setResult({ cards: [...result.cards, ...more.cards], hasMore: more.hasMore, page, query })
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = new URLSearchParams()
    for (const key of ['q', 'type', 'set']) {
      const value = String(form.get(key) ?? '').trim()
      if (value) next.set(key, value)
    }
    const colors = form.getAll('color').join('')
    if (colors) next.set('colors', colors)
    if (form.get('extras')) next.set('extras', 'true')
    setParams(next)
  }

  const loading = !failed && result?.query !== query

  return (
    <>
      <h1>Cards</h1>
      <form className="card-filters" role="search" onSubmit={search} key={query}>
        <input
          type="search"
          name="q"
          aria-label="Card name"
          placeholder="Card name"
          defaultValue={params.get('q') ?? ''}
          autoFocus
        />
        <fieldset className="colors">
          <legend>Colors</legend>
          {colorOptions.map(([code, label]) => (
            <label key={code} title={label}>
              <input
                type="checkbox"
                name="color"
                value={code}
                defaultChecked={(params.get('colors') ?? '').includes(code)}
              />
              <img src={`https://svgs.scryfall.io/card-symbols/${code}.svg`} alt={label} />
            </label>
          ))}
        </fieldset>
        <input
          name="type"
          aria-label="Type"
          placeholder="Type, e.g. Instant"
          defaultValue={params.get('type') ?? ''}
        />
        <input
          name="set"
          aria-label="Set"
          placeholder="Set code"
          list="set-codes"
          defaultValue={params.get('set') ?? ''}
        />
        <datalist id="set-codes">
          {sets.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </datalist>
        <label className="check">
          <input type="checkbox" name="extras" defaultChecked={params.get('extras') === 'true'} />
          Include tokens and art cards
        </label>
        <button type="submit">Search</button>
        <CurrencyToggle currency={currency} onChange={setCurrency} />
      </form>

      {failed && <p role="alert">Card search is unavailable right now.</p>}
      {loading && <p aria-live="polite">Searching…</p>}
      {!loading && result?.cards.length === 0 && <p>No cards found.</p>}

      {!loading && result && result.cards.length > 0 && (
        <>
          <ul className="card-grid" aria-label="Search results">
            {result.cards.map((card) => (
              <li key={card.id}>
                <Link to={`/cards/${card.id}`}>
                  {card.image ? (
                    <img src={card.image} alt={card.name} loading="lazy" />
                  ) : (
                    <div className="card-placeholder">{card.name}</div>
                  )}
                  <span className="card-name">{card.name}</span>
                  <span className="card-price">{formatPrice(card[currency], currency)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {result.hasMore && (
            <button type="button" className="load-more" onClick={loadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </>
  )
}
