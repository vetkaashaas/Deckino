import { Badge, Group, Paper, Skeleton, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getJson } from '../api'
import { formatPrice, type Currency } from '../components/currency'
import { finishLabels } from '../decks/deck'
import type * as Api from '../generated'
import classes from './CollectionValue.module.css'
import { Icon } from '../components/Icon'

// GET /api/collection/prices: every binder's cards valued now, the change over the last week, and the biggest movers.
type CollectionPrices = Api.CollectionPrices

const signed = (value: number, currency: Currency) => `${value < 0 ? '−' : '+'}${formatPrice(Math.abs(value), currency)}`

export function CollectionValue({ currency }: { currency: Currency }) {
  const [prices, setPrices] = useState<CollectionPrices | null>()

  useEffect(() => {
    let current = true
    getJson(`/api/collection/prices?currency=${currency}`)
      .then((p) => current && setPrices(p))
      .catch(() => current && setPrices(null))
    return () => {
      current = false
    }
  }, [currency])

  if (prices === null) return null
  if (prices === undefined) return <Skeleton height={120} radius="lg" mb="xl" aria-busy="true" />

  const up = prices.weekChange >= 0
  const shown: Currency = prices.currency === 'eur' ? 'eur' : 'usd' // the prices' own, until the next ones arrive
  return (
    <Paper className={classes.panel} aria-label="Collection value" component="section">
      <div>
        <Text size="sm" c="dimmed">
          Your collection
        </Text>
        <Text className={classes.value} data-testid="collection-value">
          {formatPrice(prices.value, shown)}
        </Text>
        {prices.weekChange !== 0 && (
          <Group gap={4} data-testid="collection-change">
            {up ? <Icon name="trending_up" size={18} className={classes.up} /> : <Icon name="trending_down" size={18} className={classes.down} />}
            <Text size="sm">
              Your binders are {up ? 'up' : 'down'} {formatPrice(Math.abs(prices.weekChange), shown)} this week.
            </Text>
          </Group>
        )}
      </div>

      {prices.movers.length > 0 && (
        <div className={classes.movers}>
          <Title order={3} size="h5" mb={6}>
            Biggest movers this week
          </Title>
          <ul aria-label="Biggest movers">
            {prices.movers.map((m) => (
              <li key={`${m.card.id}:${m.finish}`} aria-label={m.card.name}>
                <Link to={`/cards/${m.card.id}`} className={classes.moverName}>
                  {m.card.name}
                </Link>
                {m.finish !== 'nonfoil' && (
                  <Badge size="xs" variant="gradient">
                    {finishLabels[m.finish]}
                  </Badge>
                )}
                {m.count > 1 && (
                  <Text span size="xs" c="dimmed">
                    ×{m.count}
                  </Text>
                )}
                <Text span size="sm" className={classes.moverChange}>
                  {m.percent >= 0 ? '+' : '−'}
                  {Math.abs(m.percent).toFixed(1)}% · {signed(m.change, shown)}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Paper>
  )
}
