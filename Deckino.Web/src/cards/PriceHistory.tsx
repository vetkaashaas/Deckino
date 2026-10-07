import { Group, SegmentedControl, Table, Text } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { IconArrowDownRight, IconArrowRight, IconArrowUpRight } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { getJson } from '../api'
import { formatPrice, type Currency } from '../components/currency'
import { finishLabels, priceOf, type Finish } from '../decks/deck'
import type { CardDetail } from './api'
import classes from './PriceHistory.module.css'

// GET /api/cards/{id}/prices: one row per day, oldest first, up to 90 days.
interface PricePoint {
  date: string
  usd: number | null
  usdFoil: number | null
  usdEtched: number | null
  eur: number | null
  eurFoil: number | null
}

const height = 220
const pad = { top: 12, right: 16, bottom: 28, left: 64 }
const day = 86_400_000

// 3 to 5 round tick values covering [min, max].
function ticks(min: number, max: number) {
  if (min === max) [min, max] = [min * 0.9, max * 1.1 || 1]
  const raw = (max - min) / 3
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!
  const start = Math.floor(min / step) * step
  const values: number[] = []
  for (let v = start; v <= max + step * 0.001 || values.length < 2; v += step) values.push(Number(v.toFixed(10)))
  return values
}

const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

// The price `days` ago: the latest recorded day on or before then.
function priceAgo(series: { date: string; value: number }[], days: number) {
  const cutoff = new Date(Date.now() - days * day).toISOString().slice(0, 10)
  return series.filter((p) => p.date <= cutoff).at(-1)?.value ?? null
}

function Movement({ label, now, then, currency }: { label: string; now: number | null; then: number | null; currency: Currency }) {
  if (now === null || then === null || then === 0) {
    return (
      <div className={classes.move}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text size="sm" c="dimmed">
          —
        </Text>
      </div>
    )
  }
  const change = now - then
  const percent = (change / then) * 100
  const Icon = change > 0 ? IconArrowUpRight : change < 0 ? IconArrowDownRight : IconArrowRight
  const sign = change > 0 ? '+' : change < 0 ? '−' : '±'
  return (
    <div className={classes.move} data-testid={`move-${label}`}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Group gap={4} wrap="nowrap">
        <Icon size={16} className={change > 0 ? classes.up : change < 0 ? classes.down : undefined} aria-hidden />
        <Text size="sm" fw={600} className={classes.figure}>
          {sign}
          {formatPrice(Math.abs(change), currency)} ({sign}
          {Math.abs(percent).toFixed(1)}%)
        </Text>
      </Group>
    </div>
  )
}

// A printing's 90-day price chart in one finish and currency, with 24h / 7d / 30d movement against today's price.
export function PriceHistory({ card, currency }: { card: CardDetail; currency: Currency }) {
  const [points, setPoints] = useState<PricePoint[] | null>()
  const finishes = (card.finishes as Finish[]).filter((f) => priceOf(card.prices, f, currency) !== null)
  const [chosen, setChosen] = useState<Finish | null>(null)
  const finish = chosen && finishes.includes(chosen) ? chosen : (finishes[0] ?? 'nonfoil')
  const { ref, width } = useElementSize()
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    let current = true
    getJson<PricePoint[]>(`/api/cards/${card.id}/prices`)
      .then((p) => current && setPoints(p))
      .catch(() => current && setPoints(null))
    return () => {
      current = false
    }
  }, [card.id])

  const series = (points ?? []).flatMap((p) => {
    const value = priceOf(p, finish, currency)
    return value === null ? [] : [{ date: p.date, value }]
  })
  const now = priceOf(card.prices, finish, currency)

  if (points === undefined) return <div className={classes.chart} style={{ height }} aria-busy="true" />
  if (finishes.length === 0) return null

  const values = series.map((p) => p.value)
  const yTicks = series.length ? ticks(Math.min(...values), Math.max(...values)) : []
  const [yMin, yMax] = [yTicks[0], yTicks.at(-1)!]
  const times = series.map((p) => Date.parse(p.date))
  const [tMin, tMax] = [times[0], times.at(-1)!]
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const x = (i: number) => pad.left + (tMax === tMin ? plotW / 2 : ((times[i] - tMin) / (tMax - tMin)) * plotW)
  const y = (v: number) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('')
  const area = series.length > 1 ? `${line}L${x(series.length - 1)},${pad.top + plotH}L${x(0)},${pad.top + plotH}Z` : ''
  const last = series.length - 1
  const shown = hover ?? null

  function pick(clientX: number, rect: DOMRect) {
    const px = clientX - rect.left
    let best = 0
    series.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
    })
    setHover(best)
  }

  return (
    <div>
      <Group justify="space-between" align="flex-end" mb="sm" gap="md">
        <Group gap="lg">
          <Movement label="24h" now={now} then={priceAgo(series, 1)} currency={currency} />
          <Movement label="7d" now={now} then={priceAgo(series, 7)} currency={currency} />
          <Movement label="30d" now={now} then={priceAgo(series, 30)} currency={currency} />
        </Group>
        {finishes.length > 1 && (
          <SegmentedControl
            aria-label="Finish"
            size="xs"
            value={finish}
            onChange={(f) => setChosen(f as Finish)}
            data={finishes.map((f) => ({ value: f, label: finishLabels[f] }))}
          />
        )}
      </Group>

      <div ref={ref} className={classes.chart}>
        {series.length === 0 ? (
          <Text c="dimmed" size="sm" className={classes.empty}>
            No price history yet. Deckino records prices once a day.
          </Text>
        ) : (
          width > 0 && (
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={`${finishLabels[finish]} price in ${currency.toUpperCase()} over the last ${series.length} days with a price`}
              tabIndex={0}
              onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
              onPointerLeave={() => setHover(null)}
              onBlur={() => setHover(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? last) - 1))
                if (e.key === 'ArrowRight') setHover((h) => Math.min(last, (h ?? last - 1) + 1))
              }}
            >
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={classes.grid} />
                  <text x={pad.left - 8} y={y(t)} className={classes.axis} textAnchor="end" dominantBaseline="middle">
                    {formatPrice(t, currency)}
                  </text>
                </g>
              ))}
              <text x={pad.left} y={height - 8} className={classes.axis}>
                {dateLabel(series[0].date)}
              </text>
              {last > 0 && (
                <text x={width - pad.right} y={height - 8} className={classes.axis} textAnchor="end">
                  {dateLabel(series[last].date)}
                </text>
              )}
              {area && <path d={area} className={classes.area} />}
              <path d={line} className={classes.line} />
              {shown !== null && (
                <line x1={x(shown)} x2={x(shown)} y1={pad.top} y2={pad.top + plotH} className={classes.crosshair} />
              )}
              <circle cx={x(shown ?? last)} cy={y(series[shown ?? last].value)} r={4} className={classes.dot} />
            </svg>
          )
        )}
        {shown !== null && series[shown] && (
          <div
            className={classes.tooltip}
            style={{ left: Math.min(Math.max(x(shown), 70), width - 70), top: Math.max(0, y(series[shown].value) - 56) }}
            role="status"
          >
            <strong>{formatPrice(series[shown].value, currency)}</strong>
            <span>{dateLabel(series[shown].date)}</span>
          </div>
        )}
      </div>

      {series.length > 0 && (
        <details className={classes.table}>
          <summary>Show as table</summary>
          <Table striped withRowBorders={false} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th ta="right">{finishLabels[finish]}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[...series].reverse().map((p) => (
                <Table.Tr key={p.date}>
                  <Table.Td>{p.date}</Table.Td>
                  <Table.Td ta="right">{formatPrice(p.value, currency)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </details>
      )}
    </div>
  )
}
