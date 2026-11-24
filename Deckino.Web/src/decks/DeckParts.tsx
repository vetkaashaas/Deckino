import { Badge, Collapse, Text, Title, UnstyledButton } from '@mantine/core'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { printingLabel } from '../cards/api'
import { CardImage } from '../components/CardImage'
import { CardPreview } from '../components/CardPreview'
import { formatPrice, type Currency } from '../components/currency'
import { ManaSymbols } from '../components/ManaSymbols'
import { countCards, entryKey, entryPrice, finishLabels, formatLabel, groupByType, groupIcon, jumpId, sectionLabel, type DeckEntry, type SectionName } from './deck'
import classes from './DeckPage.module.css'
import { Icon } from '../components/Icon'

// "Legal in X", or "Not legal in X" with a count that opens the reasons. Named by its verdict, so tests and screen
// readers find it as a region. `aside` (the save status) sits beside the chip, outside the region, and stays put when
// the reasons open underneath.
export function LegalityAlert({
  format,
  warnings,
  defaultOpen = false,
  aside,
}: {
  format: string
  warnings: string[]
  defaultOpen?: boolean
  aside?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const label = formatLabel
  const region =
    warnings.length === 0 ? (
      <div role="region" aria-label={`Legal in ${label(format)}`} className={classes.legality} data-legal>
        <span className={classes.legalityChip}>
          <Icon name="check_circle" size={16} />
          Legal in {label(format)}
        </span>
      </div>
    ) : (
      <div role="region" aria-label={`Not legal in ${label(format)}`} className={classes.legality}>
        <UnstyledButton className={classes.legalityChip} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="warning" size={16} />
          Not legal in {label(format)}
          <span className={classes.legalityCount}>{warnings.length}</span>
          <Icon name="keyboard_arrow_down" size={14} className={classes.chevron} data-open={open || undefined} />
        </UnstyledButton>
        <Collapse expanded={open} className={classes.legalityReasons}>
          <ul className={classes.legalityList}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Collapse>
      </div>
    )
  if (!aside) return region
  return (
    <div className={classes.legalityBox}>
      {region}
      <div className={classes.legalityAside}>{aside}</div>
    </div>
  )
}

// A card's name, and its finish when it isn't the normal one.
export function CardName({ entry, link = false }: { entry: DeckEntry; link?: boolean }) {
  const { card } = entry
  return (
    <span className={classes.name} data-preview>
      {link ? (
        <Link to={`/cards/${card.id}`} className={classes.cardName}>
          {card.name}
        </Link>
      ) : (
        <span className={classes.cardName}>{card.name}</span>
      )}
      {entry.finish !== 'nonfoil' && (
        <Badge size="xs" variant="gradient">
          {finishLabels[entry.finish]}
        </Badge>
      )}
    </span>
  )
}

// A card's row, like a binder's: how many (a crown for the commander), its picture, the name over the printing, cost
// and price, and on the owner's page a chevron for the card panel. The same on the owner's page and the public one.
function EntryCells({ section, entry, currency, link }: { section: SectionName; entry: DeckEntry; currency: Currency; link: boolean }) {
  return (
    <>
      <span className={classes.quantityCell}>
        {section === 'commander' ? (
          <Icon name="crown" size={18} className={classes.crown} label="Commander" />
        ) : (
          <span className={classes.single} data-testid="quantity">
            {entry.quantity}×
          </span>
        )}
      </span>
      <img className={classes.thumb} src={entry.card.smallImage ?? entry.card.image ?? undefined} alt="" loading="lazy" data-preview />
      <CardPreview src={entry.card.image} name={entry.card.name} foil={entry.finish !== 'nonfoil'} />
      <CardName entry={entry} link={link} />
      <Text span size="xs" c="dimmed" className={classes.printingText} data-preview>
        <span className={classes.long} data-testid="printing">
          {printingLabel(entry.card)}
        </span>
        <span className={classes.short}>
          {entry.card.setCode.toUpperCase()} #{entry.card.collectorNumber}
        </span>
      </Text>
      <span className={classes.mana} data-preview>
        <ManaSymbols text={entry.card.manaCost} />
      </span>
      <span className={classes.price} data-preview>
        {formatPrice(entryPrice(entry, currency), currency)}
      </span>
      {!link && <Icon name="chevron_right" size={18} className={classes.rowChevron} />}
    </>
  )
}

// A section's title, then its cards: grouped by type as rows, or the stacks given. With onOpen (the owner's page) a
// row opens the card panel; without it, the card's name links to its page.
export function DeckSection({
  name,
  format,
  entries,
  empty,
  stacks,
  currency,
  onOpen,
}: {
  name: SectionName
  format: string
  entries: DeckEntry[]
  empty?: ReactNode
  stacks?: ReactNode
  currency: Currency
  onOpen?: (entry: DeckEntry) => void
}) {
  const groups = name === 'commander' ? [{ label: '', entries }] : groupByType(entries)
  const label = sectionLabel(name, format)
  return (
    <section id={jumpId(name)} className={classes.section} aria-label={label}>
      <Title order={2} className={classes.sectionTitle}>
        {label} <span className={classes.count}>{countCards(entries)}</span>
      </Title>
      {entries.length === 0 && empty && <Text c="dimmed">{empty}</Text>}
      {stacks ??
        groups.map((group) => (
          <div key={group.label || 'all'} className={classes.group}>
            {group.label && (
              <Title order={3} id={jumpId(name, group.label)} className={classes.groupTitle}>
                <TypeLabel label={group.label} size={18} /> <span className={classes.count}>{countCards(group.entries)}</span>
              </Title>
            )}
            <ul className={classes.rows}>
              {group.entries.map((entry) => (
                <li key={entryKey(entry)} className={onOpen ? undefined : classes.row} aria-label={entry.card.name}>
                  {onOpen ? (
                    <UnstyledButton className={classes.row} aria-label={`Edit ${entry.card.name}`} onClick={() => onOpen(entry)}>
                      <EntryCells section={name} entry={entry} currency={currency} link={false} />
                    </UnstyledButton>
                  ) : (
                    <EntryCells section={name} entry={entry} currency={currency} link />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}

// A card-type group's name after its symbol, when it has one.
export function TypeLabel({ label, size, hideLabel }: { label: string; size: number; hideLabel?: boolean }) {
  const icon = groupIcon(label)
  if (!icon) return label
  return (
    <>
      <Icon name={icon} size={size} className={classes.typeIcon} />
      <span className={hideLabel ? classes.phoneHidden : undefined}>{label}</span>
    </>
  )
}

// A button per part of the deck (the commander, each card type of the main deck, the sideboard) that scrolls to it.
// Put it in the sticky bar: the part lands just under that bar.
export function DeckJumps({ deck, format }: { deck: Record<SectionName, DeckEntry[]>; format: string }) {
  const jumps = [
    ...(deck.commander.length > 0 ? [{ id: jumpId('commander'), label: sectionLabel('commander', format), count: countCards(deck.commander) }] : []),
    ...groupByType(deck.mainboard).map((g) => ({ id: jumpId('mainboard', g.label), label: g.label, count: countCards(g.entries) })),
    ...(deck.sideboard.length > 0 ? [{ id: jumpId('sideboard'), label: sectionLabel('sideboard', format), count: countCards(deck.sideboard) }] : []),
  ]
  if (jumps.length < 2) return null

  function jump(id: string, from: HTMLElement) {
    const target = document.getElementById(id)
    const bar = from.closest('nav')?.parentElement
    if (!target || !bar) return
    const below = (parseFloat(getComputedStyle(bar).top) || 0) + bar.offsetHeight + 8
    window.scrollTo({
      top: target.getBoundingClientRect().top + window.scrollY - below,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }

  return (
    <nav aria-label="Jump to" className={classes.jumps}>
      {jumps.map((j) => (
        <UnstyledButton key={j.id} className={classes.jump} onClick={(e) => jump(j.id, e.currentTarget)}>
          {/* On a phone a chip with a symbol shows only the symbol and count; the name stays for screen readers. */}
          <TypeLabel label={j.label} size={16} hideLabel /> <span className={classes.count}>{j.count}</span>
        </UnstyledButton>
      ))}
    </nav>
  )
}

// The deck page's header: the commander's card beside the title (or nothing), facts underneath, actions on the right.
export function DeckHero({
  card,
  children,
  actions,
}: {
  card?: DeckEntry
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={classes.hero} data-with-card={card ? true : undefined}>
      {card && (
        <div className={classes.heroCard}>
          <CardImage src={card.card.image} alt={card.card.name} foil={card.finish !== 'nonfoil'} />
        </div>
      )}
      <div className={classes.heroText}>{children}</div>
      {actions && <div className={classes.heroActions}>{actions}</div>}
    </div>
  )
}
