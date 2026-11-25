import { ActionIcon, Badge, Button, Collapse, Group, Menu, Text, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { printingLabel } from '../cards/api'
import { CardImage } from '../components/CardImage'
import { CardPreview } from '../components/CardPreview'
import { formatPrice, type Currency } from '../components/currency'
import { ManaSymbols } from '../components/ManaSymbols'
import { useRemembered } from '../components/useRemembered'
import {
  arrangeSection,
  countCards,
  entryKey,
  entryPrice,
  finishLabels,
  formatLabel,
  groupIcon,
  groupings,
  jumpId,
  sectionLabel,
  sortings,
  type DeckEntry,
  type DeckOrder,
  type Sorting,
  type SectionName,
} from './deck'
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

// A section's title, then its cards: in the order's groups as rows, or the stacks given. With onOpen (the owner's page) a
// row opens the card panel; without it, the card's name links to its page.
export function DeckSection({
  name,
  format,
  entries,
  empty,
  stacks,
  order,
  onOpen,
}: {
  name: SectionName
  format: string
  entries: DeckEntry[]
  empty?: ReactNode
  stacks?: ReactNode
  order: DeckOrder
  onOpen?: (entry: DeckEntry) => void
}) {
  const groups = arrangeSection(name, entries, order)
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
                      <EntryCells section={name} entry={entry} currency={order.currency} link={false} />
                    </UnstyledButton>
                  ) : (
                    <EntryCells section={name} entry={entry} currency={order.currency} link />
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

// A button per part of the deck (the commander, each group of the main deck, the sideboard) that scrolls to it.
// Put it in the sticky bar: the part lands just under that bar.
export function DeckJumps({ deck, format, order }: { deck: Record<SectionName, DeckEntry[]>; format: string; order: DeckOrder }) {
  const jumps = [
    ...(deck.commander.length > 0 ? [{ id: jumpId('commander'), label: sectionLabel('commander', format), count: countCards(deck.commander) }] : []),
    // Without groups the main deck is one jump, to the section itself.
    ...arrangeSection('mainboard', deck.mainboard, order).map((g) => ({
      id: jumpId('mainboard', g.label),
      label: g.label || sectionLabel('mainboard', format),
      count: countCards(g.entries),
    })),
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

// How the list, gallery and stacks views group and sort cards, remembered in this browser.
export function useDeckOrder(currency: Currency) {
  const [group, setGroup] = useRemembered('deckino.deckGroup', groupings.map((g) => g.value), 'type')
  const [sort, setSort] = useRemembered('deckino.deckSort', sortings.map((s) => s.value), 'manaValue')
  const [direction, setDirection] = useRemembered('deckino.deckSortDirection', ['ascending', 'descending'] as const, 'ascending')
  return {
    order: { group, sort, descending: direction === 'descending', currency } satisfies DeckOrder,
    setGroup,
    // A sort starts in its usual direction.
    setSort: (next: Sorting) => {
      setSort(next)
      setDirection(sortings.find((s) => s.value === next)!.startDescending ? 'descending' : 'ascending')
    },
    reverse: () => setDirection(direction === 'descending' ? 'ascending' : 'descending'),
  }
}

// One menu for both: the button says what's chosen ("Type · Mana value"). Beside it, an arrow that reverses the sort.
export function DeckOrderMenu({ order, setGroup, setSort, reverse }: ReturnType<typeof useDeckOrder>) {
  const group = groupings.find((g) => g.value === order.group)!
  const sort = sortings.find((s) => s.value === order.sort)!
  // Both lists have a "Mana value": each item's name says which list it's in.
  const item = (list: string, label: string, checked: boolean, onClick: () => void) => (
    <Menu.Item
      key={label}
      aria-label={`${list} ${label.toLowerCase()}${checked ? ', selected' : ''}`}
      onClick={onClick}
      rightSection={checked ? <Icon name="check" size={16} /> : null}
    >
      {label}
    </Menu.Item>
  )
  const direction = order.descending ? sort.descending : sort.ascending
  return (
    <Group gap={2} wrap="nowrap">
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            aria-label={`Group by ${group.label.toLowerCase()}, sort by ${sort.label.toLowerCase()}`}
            leftSection={<Icon name="sort" size={16} />}
            rightSection={<Icon name="keyboard_arrow_down" size={14} />}
          >
            {group.label} · {sort.label}
          </Button>
        </Menu.Target>
        <Menu.Dropdown miw={180}>
          <Menu.Label>Group by</Menu.Label>
          {groupings.map((g) => item('Group by', g.label, g.value === order.group, () => setGroup(g.value)))}
          <Menu.Divider />
          <Menu.Label>Sort by</Menu.Label>
          {sortings.map((s) => item('Sort by', s.label, s.value === order.sort, () => setSort(s.value)))}
        </Menu.Dropdown>
      </Menu>
      <Tooltip label={`${direction}, click to reverse`}>
        <ActionIcon variant="subtle" color="gray" aria-label={`Reverse order, now ${direction.toLowerCase()}`} onClick={reverse}>
          <Icon name={order.descending ? 'arrow_downward' : 'arrow_upward'} size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
