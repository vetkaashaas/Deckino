import { Chip, Group, Text } from '@mantine/core'
import { Link } from 'react-router'
import { finishLabels } from '../decks/deck'
import type * as Api from '../generated'
import { formatPrice, signed, type Currency } from './currency'
import classes from './MoverRow.module.css'

export const moverList = classes.list

// Rising | Falling, as chips: which way a list of movers goes. `label` names it (two lists can share a page).
export function RisingFalling({ falling, onChange, label }: { falling: boolean; onChange: (falling: boolean) => void; label: string }) {
  return (
    <Chip.Group value={falling ? 'falling' : 'rising'} onChange={(v) => onChange(v === 'falling')}>
      <Group gap={8} role="radiogroup" aria-label={label}>
        <Chip value="rising">Rising</Chip>
        <Chip value="falling">Falling</Chip>
      </Group>
    </Chip.Group>
  )
}

// One of this week's biggest price moves, with today's price, as the app's MoverRow: in the market by percent
// (`market`, Home's movers), or in your binders by what it changed your value, with how many and a foil marked.
export function MoverRow({ mover, currency, market = false }: { mover: Api.PriceMover; currency: Currency; market?: boolean }) {
  const { card } = mover
  const up = mover.change > 0
  const detail = [
    `${!market && mover.count > 1 ? `${mover.count} × ` : ''}${formatPrice(mover.now, currency)}`,
    !market && mover.finish !== 'nonfoil' ? finishLabels[mover.finish] : null,
    card.setName,
  ]
  return (
    <li aria-label={card.name}>
      <Link to={`/cards/${card.id}`} className={classes.row}>
        <img className={classes.cover} src={card.smallImage ?? card.image ?? undefined} alt="" loading="lazy" />
        <span className={classes.text}>
          <span className={classes.name}>{card.name}</span>
          <Text span size="xs" c="dimmed">
            {detail.filter(Boolean).join(' · ')}
          </Text>
        </span>
        <span className={classes.change} data-up={up || undefined}>
          {market ? `${up ? '+' : '−'}${Math.round(Math.abs(mover.percent))}%` : signed(mover.change, currency)}
        </span>
      </Link>
    </li>
  )
}
