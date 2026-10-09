import { ActionIcon, Badge, Group, Tooltip } from '@mantine/core'
import { IconMinus, IconPlus, IconZoomIn, IconZoomOut } from '@tabler/icons-react'
import { Link } from 'react-router'
import { CardImage } from '../components/CardImage'
import { formatPrice, type Currency } from '../components/currency'
import { useRemembered } from '../components/useRemembered'
import { CardMenu, type CardActions } from './CardMenu'
import { countCards, entryKey, entryPrice, finishLabels, groupByType, type DeckEntry, type SectionName } from './deck'
import classes from './DeckGallery.module.css'

// A card's width in the grid, in pixels. Fixed rather than stretched to fill the row, so every step shows: a
// stretched grid only changes when a whole column fits or goes.
const sizes = [120, 140, 160, 190, 220, 260]

// How big the gallery's cards are, remembered in this browser.
export const useGallerySize = () => useRemembered('deckino.gallerySize', sizes, 160)

// Smaller and larger cards: a step down or up the sizes.
export function GallerySizeControl({ size, onChange }: { size: number; onChange: (size: number) => void }) {
  const at = sizes.indexOf(size)
  return (
    <Group gap={2} wrap="nowrap" role="group" aria-label="Card size">
      <Tooltip label="Smaller cards">
        <ActionIcon variant="subtle" color="gray" aria-label="Smaller cards" disabled={at <= 0} onClick={() => onChange(sizes[at - 1])}>
          <IconZoomOut size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Larger cards">
        <ActionIcon variant="subtle" color="gray" aria-label="Larger cards" disabled={at >= sizes.length - 1} onClick={() => onChange(sizes[at + 1])}>
          <IconZoomIn size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

// One card, whole: its count, and on hover − and + for the quantity (where more than one copy is allowed). A click
// opens its card page, a right-click its actions. Underneath, its price and printing.
function GalleryCard({ entry, actions, currency }: { entry: DeckEntry; actions?: CardActions; currency: Currency }) {
  const { card } = entry
  const foil = entry.finish !== 'nonfoil'
  const face = <CardImage src={card.image} alt={card.name} foil={foil} lazy />
  const canAdd = actions?.canAdd(entry) ?? false
  return (
    <li className={classes.card} aria-label={card.name}>
      <div className={classes.frame}>
        {actions ? (
          <CardMenu entry={entry} actions={actions} className={classes.button} buttonClassName={classes.more} link>
            {face}
          </CardMenu>
        ) : (
          <Link to={`/cards/${card.id}`} className={classes.button} aria-label={card.name}>
            {face}
          </Link>
        )}
        {entry.quantity > 1 && <span className={classes.quantity}>{entry.quantity}×</span>}
        {actions && (canAdd || entry.quantity > 1) && (
          <div className={classes.stepper}>
            <ActionIcon
              variant="transparent"
              color="gray"
              size="sm"
              aria-label={`Remove a copy of ${card.name}`}
              disabled={entry.quantity <= 1}
              onClick={() => actions.onQuantity(entry, entry.quantity - 1)}
            >
              <IconMinus size={14} />
            </ActionIcon>
            <span className={classes.stepperCount}>{entry.quantity}</span>
            <ActionIcon
              variant="transparent"
              color="gray"
              size="sm"
              aria-label={`Add a copy of ${card.name}`}
              disabled={!canAdd}
              onClick={() => actions.onQuantity(entry, entry.quantity + 1)}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </div>
        )}
      </div>
      <div className={classes.meta}>
        <span className={classes.price}>{formatPrice(entryPrice(entry, currency), currency)}</span>
        {foil && (
          <Badge size="xs" variant="gradient">
            {finishLabels[entry.finish]}
          </Badge>
        )}
        <span className={classes.set}>
          {card.setCode.toUpperCase()} #{card.collectorNumber}
        </span>
      </div>
    </li>
  )
}

// A section as a gallery of whole cards, grouped by type: the view for seeing a deck the way it looks on the table.
export function DeckGallery({
  section,
  entries,
  actions,
  currency,
  size = 160,
}: {
  section: SectionName
  entries: DeckEntry[]
  actions?: CardActions
  currency: Currency
  size?: number
}) {
  const groups = section === 'commander' ? [{ label: '', entries }] : groupByType(entries)
  return (
    <div className={classes.groups}>
      {groups.map((group) => (
        <div key={group.label || 'all'}>
          {group.label && (
            <h3 className={classes.title}>
              {group.label} <span className={classes.count}>{countCards(group.entries)}</span>
            </h3>
          )}
          <ul className={classes.grid} style={{ gridTemplateColumns: `repeat(auto-fill, min(${size}px, 46%))` }}>
            {group.entries.map((entry) => (
              <GalleryCard key={entryKey(entry)} entry={entry} actions={actions} currency={currency} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
