import { ActionIcon, Badge, CopyButton, Group, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { sendJson } from '../api'
import { CardImage } from '../components/CardImage'
import { formatPrice, type Currency } from '../components/currency'
import { useRemembered } from '../components/useRemembered'
import { CardButton, type CardActions } from './CardButton'
import { arrangeSection, countCards, entryKey, entryPrice, finishLabels, jumpId, type DeckCard, type DeckEntry, type DeckOrder, type DeckSections, type SectionName } from './deck'
import { TypeLabel } from './DeckParts'
import classes from './DeckGallery.module.css'
import pageClasses from './DeckPage.module.css'
import { Icon } from '../components/Icon'

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
          <Icon name="zoom_out" size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Larger cards">
        <ActionIcon variant="subtle" color="gray" aria-label="Larger cards" disabled={at >= sizes.length - 1} onClick={() => onChange(sizes[at + 1])}>
          <Icon name="zoom_in" size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

// One card, whole: its count, and on hover − and + for the quantity (where more than one copy is allowed). A click
// opens it in the card panel. Underneath, its name (a click copies it), then its price.
function GalleryCard({ entry, actions, currency }: { entry: DeckEntry; actions?: CardActions; currency: Currency }) {
  const { card } = entry
  const foil = entry.finish !== 'nonfoil'
  const face = <CardImage src={card.image} alt={card.name} foil={foil} lazy />
  const canAdd = actions?.canAdd(entry) ?? false
  return (
    <li className={classes.card} aria-label={card.name}>
      <div className={classes.frame}>
        {actions ? (
          <CardButton entry={entry} actions={actions} className={classes.button}>
            {face}
          </CardButton>
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
              <Icon name="remove" size={14} />
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
              <Icon name="add" size={14} />
            </ActionIcon>
          </div>
        )}
      </div>
      <div className={classes.meta}>
        <CopyButton value={card.name}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : `Copy ${card.name}`} withArrow>
              <UnstyledButton className={classes.name} onClick={copy}>
                {card.name}
              </UnstyledButton>
            </Tooltip>
          )}
        </CopyButton>
        <div className={classes.details}>
          <span className={classes.price}>{formatPrice(entryPrice(entry, currency), currency)}</span>
          {foil && (
            <Badge size="xs" variant="gradient">
              {finishLabels[entry.finish]}
            </Badge>
          )}
        </div>
      </div>
    </li>
  )
}

// A section as a gallery of whole cards, in the chosen groups: the view for seeing a deck the way it looks on the table.
export function DeckGallery({
  section,
  entries,
  order,
  actions,
  size = 160,
}: {
  section: SectionName
  entries: DeckEntry[]
  order: DeckOrder
  actions?: CardActions
  size?: number
}) {
  const groups = arrangeSection(section, entries, order)
  return (
    <div className={classes.groups}>
      {groups.map((group) => (
        <div key={group.label || 'all'}>
          {group.label && (
            <h3 id={jumpId(section, group.label)} className={classes.title}>
              <TypeLabel label={group.label} size={16} /> <span className={classes.count}>{countCards(group.entries)}</span>
            </h3>
          )}
          <ul className={classes.grid} style={{ gridTemplateColumns: `repeat(auto-fill, min(${size}px, 46%))` }}>
            {group.entries.map((entry) => (
              <GalleryCard key={entryKey(entry)} entry={entry} actions={actions} currency={order.currency} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

// The tokens (and emblems) the deck's cards make, under the deck: to look at only. They aren't part of the deck, so
// no count, value, legality or export includes them, and they can't be added or removed by hand.
export function DeckTokens({ deck, currency, size = 160 }: { deck: DeckSections; currency: Currency; size?: number }) {
  const ids = [...new Set([...deck.commander, ...deck.mainboard, ...deck.sideboard].map((e) => e.scryfallId))].sort().slice(0, 250) // the API's MaxTokenCards
  const key = ids.join(',')
  const [tokens, setTokens] = useState<DeckCard[]>([])
  useEffect(() => {
    if (!key) return setTokens([])
    let current = true
    sendJson('POST', '/api/cards/tokens', { cardIds: key.split(',') })
      .then((t) => current && setTokens(t))
      .catch(() => {}) // nice to have: the deck works without them
    return () => {
      current = false
    }
  }, [key])
  if (tokens.length === 0) return null
  return (
    <section className={pageClasses.section} aria-label="Tokens">
      <Title order={2} className={pageClasses.sectionTitle}>
        Tokens <span className={pageClasses.count}>{tokens.length}</span>
      </Title>
      <ul className={classes.grid} style={{ gridTemplateColumns: `repeat(auto-fill, min(${size}px, 46%))` }}>
        {tokens.map((card) => (
          <GalleryCard key={card.id} entry={{ scryfallId: card.id, quantity: 1, finish: 'nonfoil', card }} currency={currency} />
        ))}
      </ul>
    </section>
  )
}
