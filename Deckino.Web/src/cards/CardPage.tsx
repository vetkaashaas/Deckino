import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getJson, type CardDetail, type CardFace } from './api'
import { CurrencyToggle, formatPrice, Symbols, useCurrency } from './format'

function FaceText({ face }: { face: CardFace }) {
  const stats = face.loyalty ? `Loyalty ${face.loyalty}` : face.power ? `${face.power}/${face.toughness}` : null
  return (
    <section className="face">
      <h2>
        {face.name} <span className="mana">{face.manaCost && <Symbols text={face.manaCost} />}</span>
      </h2>
      {face.typeLine && <p className="type-line">{face.typeLine}</p>}
      {face.oracleText && (
        <p className="oracle-text">
          <Symbols text={face.oracleText} />
        </p>
      )}
      {stats && <p className="stats">{stats}</p>}
      {face.flavorText && <p className="flavor-text">{face.flavorText}</p>}
    </section>
  )
}

export default function CardPage() {
  const { id } = useParams()
  const [card, setCard] = useState<CardDetail | null>()
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    const controller = new AbortController()
    getJson<CardDetail>(`/api/cards/${id}`, controller.signal)
      .then(setCard)
      .catch(() => !controller.signal.aborted && setCard(null))
    return () => controller.abort()
  }, [id])

  if (card === undefined) return <p aria-live="polite">Loading…</p>
  if (card === null) return <p role="alert">Card not found.</p>

  const prices =
    currency === 'usd'
      ? [
          ['Normal', card.prices.usd],
          ['Foil', card.prices.usdFoil],
          ['Etched', card.prices.usdEtched],
        ]
      : [
          ['Normal', card.prices.eur],
          ['Foil', card.prices.eurFoil],
        ]
  const shownPrices = prices.filter(([, value]) => value !== null) as [string, number][]

  return (
    <article className="card-page">
      <div className="card-images">
        {card.images.map((src, i) => (
          <img key={src} src={src} alt={i === 0 ? card.name : `${card.name} (back face)`} />
        ))}
      </div>

      <div className="card-info">
        <h1>{card.name}</h1>
        {card.faces.length > 0 ? (
          card.faces.map((face) => <FaceText key={face.name} face={face} />)
        ) : (
          <FaceText face={card} />
        )}

        <dl className="printing-info">
          <dt>Set</dt>
          <dd data-testid="card-set">
            {card.setName} ({card.setCode.toUpperCase()}) #{card.collectorNumber}
          </dd>
          <dt>Rarity</dt>
          <dd className="capitalize">{card.rarity}</dd>
          {card.artist && (
            <>
              <dt>Artist</dt>
              <dd>{card.artist}</dd>
            </>
          )}
          <dt>Released</dt>
          <dd>{card.releasedAt}</dd>
        </dl>

        <section aria-label="Prices" className="prices">
          <div className="prices-header">
            <h2>Prices</h2>
            <CurrencyToggle currency={currency} onChange={setCurrency} />
          </div>
          {shownPrices.length === 0 ? (
            <p>No {currency.toUpperCase()} price available.</p>
          ) : (
            <dl data-testid="prices">
              {shownPrices.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{formatPrice(value, currency)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section aria-label="Printings" className="printings">
          <h2>Printings ({card.printings.length})</h2>
          <ul>
            {card.printings.map((p) => (
              <li key={p.id}>
                <Link to={`/cards/${p.id}`} aria-current={p.id === card.id ? 'page' : undefined}>
                  <span>
                    {p.setName} ({p.setCode.toUpperCase()}) #{p.collectorNumber}
                    {p.lang !== 'en' && ` · ${p.lang.toUpperCase()}`}
                  </span>
                  <span className="printing-meta">
                    {p.releasedAt.slice(0, 4)} · {formatPrice(p[currency], currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </article>
  )
}
