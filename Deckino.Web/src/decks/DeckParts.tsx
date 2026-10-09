import { Badge, Collapse, HoverCard, Text, Title, UnstyledButton } from '@mantine/core'
import { IconAlertTriangle, IconChevronDown, IconCircleCheck } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { CardImage } from '../components/CardImage'
import { countCards, entryKey, finishLabels, formatLabel, groupByType, sectionLabel, type DeckEntry, type SectionName } from './deck'
import classes from './DeckPage.module.css'

// "Legal in X", or "Not legal in X" with a count that opens the reasons. Named by its verdict, so tests and screen
// readers find it as a region.
export function LegalityAlert({ format, warnings, defaultOpen = false }: { format: string; warnings: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const label = formatLabel
  if (warnings.length === 0) {
    return (
      <div role="region" aria-label={`Legal in ${label(format)}`} className={classes.legality} data-legal>
        <span className={classes.legalityChip}>
          <IconCircleCheck size={16} />
          Legal in {label(format)}
        </span>
      </div>
    )
  }
  return (
    <div role="region" aria-label={`Not legal in ${label(format)}`} className={classes.legality}>
      <UnstyledButton className={classes.legalityChip} aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconAlertTriangle size={16} />
        Not legal in {label(format)}
        <span className={classes.legalityCount}>{warnings.length}</span>
        <IconChevronDown size={14} className={classes.chevron} data-open={open || undefined} />
      </UnstyledButton>
      <Collapse expanded={open}>
        <ul className={classes.legalityList}>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </Collapse>
    </div>
  )
}

// A card's name with a picture of it on hover, and its finish when it isn't the normal one.
export function CardName({ entry, link = false }: { entry: DeckEntry; link?: boolean }) {
  const { card } = entry
  return (
    <HoverCard position="right" openDelay={120} disabled={!card.image}>
      <HoverCard.Target>
        <span className={classes.name}>
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
      </HoverCard.Target>
      <HoverCard.Dropdown p={0} className={classes.preview}>
        <CardImage src={card.image} alt={card.name} foil={entry.finish !== 'nonfoil'} />
      </HoverCard.Dropdown>
    </HoverCard>
  )
}

// A section's title, then its cards: grouped by type as rows (renderRow gives a row's cells), or the stacks given.
export function DeckSection({
  name,
  format,
  entries,
  empty,
  stacks,
  renderRow,
}: {
  name: SectionName
  format: string
  entries: DeckEntry[]
  empty?: ReactNode
  stacks?: ReactNode
  renderRow: (entry: DeckEntry) => ReactNode
}) {
  const groups = name === 'commander' ? [{ label: '', entries }] : groupByType(entries)
  const label = sectionLabel(name, format)
  return (
    <section className={classes.section} aria-label={label}>
      <Title order={2} className={classes.sectionTitle}>
        {label} <span className={classes.count}>{countCards(entries)}</span>
      </Title>
      {entries.length === 0 && empty && <Text c="dimmed">{empty}</Text>}
      {stacks ??
        groups.map((group) => (
          <div key={group.label || 'all'} className={classes.group}>
            {group.label && (
              <Title order={3} className={classes.groupTitle}>
                {group.label} <span className={classes.count}>{countCards(group.entries)}</span>
              </Title>
            )}
            <ul className={classes.rows}>
              {group.entries.map((entry) => (
                <li key={entryKey(entry)} className={classes.row} aria-label={entry.card.name}>
                  {renderRow(entry)}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
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
