import { Anchor, Group, Skeleton, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getJson } from '../api'
import { formatPrice, signed, type Currency } from '../components/currency'
import { Icon } from '../components/Icon'
import { MoverRow, moverList, RisingFalling } from '../components/MoverRow'
import classes from './CollectionValue.module.css'

// The app's collection value, on Home (where it opens Collection) and Collection: what the binders are worth and this
// week's change. No box: the value is the page's headline, with a soft shine; `line` draws the brand line under it
// where nothing below has one of its own (Home), and `movers` that many of your cards that rose (or fell) most this week under
// it (Home; Collection lists them all under Prices). `compact` is the one-line stat in Collection's header,
// `big` on its Prices tab, where the value is the point.
export function CollectionValue({
  currency,
  cards,
  to,
  line = false,
  movers = 0,
  compact = false,
  big = false,
}: {
  currency: Currency
  cards?: number
  to?: string
  line?: boolean
  movers?: number
  compact?: boolean
  big?: boolean
}) {
  const [prices, setPrices] = useState<Awaited<ReturnType<typeof load>> | null>()
  const [falling, setFalling] = useState(false)

  useEffect(() => {
    let current = true
    load(currency)
      .then((p) => current && setPrices(p))
      .catch(() => current && setPrices(null))
    return () => {
      current = false
    }
  }, [currency])

  if (prices === null) return null
  if (prices === undefined)
    return compact ? <Skeleton height={44} width={200} radius="md" aria-busy="true" /> : <Skeleton height={96} width={260} radius="lg" mb="xl" aria-busy="true" />

  const shown: Currency = prices.currency === 'eur' ? 'eur' : 'usd' // the prices' own, until the next ones arrive
  const change = prices.weekChange
  const up = change > 0
  // Against last week's value; an approximation, as only cards with a price on both days count in the change.
  const before = prices.value - change
  const percent = before > 0 ? Math.abs(change / before) * 100 : null
  const label = `Collection value${cards ? ` · ${cards} ${cards === 1 ? 'card' : 'cards'}` : ''}`
  const moved = prices.movers.filter((m) => (falling ? m.change < 0 : m.change > 0))
  const week =
    change !== 0 ? (
      <Group gap="xs" wrap="nowrap" data-testid="collection-change">
        <span className={classes.pill} data-up={up || undefined}>
          <Icon name={up ? 'trending_up' : 'trending_down'} size={16} />
          {signed(change, shown)}
          {percent !== null && ` · ${percent.toFixed(1)}%`}
        </span>
        <Text size="sm" c="dimmed">
          this week
        </Text>
      </Group>
    ) : (
      <Text size="sm" c="dimmed">
        No change this week
      </Text>
    )

  if (compact) {
    return (
      <section className={classes.compact} data-big={big || undefined} aria-label="Collection value">
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Group gap="sm" wrap="nowrap">
          <Text className={classes.compactValue} data-testid="collection-value">
            {formatPrice(prices.value, shown)}
          </Text>
          {week}
        </Group>
      </section>
    )
  }

  return (
    <section className={classes.panel} aria-label="Collection value">
      {to ? (
        <Link to={to} className={classes.label}>
          {label}
          <Icon name="chevron_right" size={16} />
        </Link>
      ) : (
        <Text size="sm" c="dimmed">
          {label}
        </Text>
      )}
      <Text className={classes.value} data-testid="collection-value">
        {formatPrice(prices.value, shown)}
      </Text>
      {week}
      {line && <div className={classes.line} />}
      {movers > 0 && prices.movers.length > 0 && (
        <div className={classes.yours}>
          <Group justify="space-between" align="center" mb="xs">
            <Title order={2} size="h5">
              Your movers this week
            </Title>
            <RisingFalling falling={falling} onChange={setFalling} label="Your movers" />
          </Group>
          {moved.length === 0 ? (
            <Text size="sm" c="dimmed">
              None of your cards {falling ? 'fell' : 'rose'} this week.
            </Text>
          ) : (
            <ul className={moverList} aria-label="Your biggest movers">
              {moved.slice(0, movers).map((m) => (
                <MoverRow key={`${m.card.id}:${m.finish}`} mover={m} currency={shown} />
              ))}
            </ul>
          )}
          {moved.length > movers && (
            <Anchor component={Link} to="/collection/prices" size="sm" fw={600} mt="xs" display="inline-block">
              See all
            </Anchor>
          )}
        </div>
      )}
    </section>
  )
}

const load = (currency: Currency) => getJson(`/api/collection/prices?currency=${currency}`)
