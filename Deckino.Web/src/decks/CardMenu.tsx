import { ActionIcon, Menu, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconArrowsExchange, IconCrown, IconDots, IconExternalLink, IconMinus, IconPhoto, IconPlus, IconTrash } from '@tabler/icons-react'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { PrintingPicker } from '../cards/PrintingPicker'
import type { Currency } from '../components/currency'
import type { DeckEntry, SectionName } from './deck'

// What can be done to a card in the stacks and gallery views; the deck page decides what's allowed.
export interface CardActions {
  canAdd: (entry: DeckEntry) => boolean
  moveTargets: (entry: DeckEntry) => { to: SectionName; label: string }[]
  onQuantity: (entry: DeckEntry, quantity: number) => void
  onMove: (entry: DeckEntry, to: SectionName) => void
  onRemove: (entry: DeckEntry) => void
  onPrinting: (entry: DeckEntry, scryfallId: string) => void
  currency: Currency
}

// A card picture with its actions on a right-click (the browser's own menu would be no use here). A left click
// opens them too, or with link, opens the card's page instead.
export function CardMenu({
  entry,
  actions,
  className,
  link = false,
  buttonClassName,
  children,
}: {
  entry: DeckEntry
  actions: CardActions
  className?: string
  link?: boolean
  // A visible ⋯ that opens the menu too: touch screens (iOS) don't right-click on a long press over a link.
  buttonClassName?: string
  children: ReactNode
}) {
  const [opened, setOpened] = useState(false)
  const [picking, picker] = useDisclosure()
  const { card } = entry
  const openMenu = (e: MouseEvent) => {
    e.preventDefault()
    setOpened(true)
  }
  return (
    <>
      {/* As a link, a click is the link's: the menu only opens from the right-click (and closes on its own). */}
      <Menu opened={opened} onChange={(o) => (link ? !o && setOpened(false) : setOpened(o))} position="right-start" withinPortal offset={8}>
        <Menu.Target>
          {link ? (
            <Link to={`/cards/${card.id}`} className={className} aria-label={card.name} onContextMenu={openMenu}>
              {children}
            </Link>
          ) : (
            <UnstyledButton className={className} aria-label={`Actions for ${card.name}`} onContextMenu={openMenu}>
              {children}
            </UnstyledButton>
          )}
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{card.name}</Menu.Label>
          {actions.canAdd(entry) && (
            <Menu.Item leftSection={<IconPlus size={16} />} onClick={() => actions.onQuantity(entry, entry.quantity + 1)}>
              Add a copy
            </Menu.Item>
          )}
          {entry.quantity > 1 && (
            <Menu.Item leftSection={<IconMinus size={16} />} onClick={() => actions.onQuantity(entry, entry.quantity - 1)}>
              Remove a copy
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconPhoto size={16} />} onClick={picker.open}>
            Change printing…
          </Menu.Item>
          {actions.moveTargets(entry).map(({ to, label }) => (
            <Menu.Item
              key={to}
              leftSection={to === 'commander' ? <IconCrown size={16} /> : <IconArrowsExchange size={16} />}
              onClick={() => actions.onMove(entry, to)}
            >
              {label}
            </Menu.Item>
          ))}
          <Menu.Item component={Link} to={`/cards/${card.id}`} leftSection={<IconExternalLink size={16} />}>
            Open card page
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => actions.onRemove(entry)}>
            Remove
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {buttonClassName && (
        <ActionIcon
          className={buttonClassName}
          variant="filled"
          color="dark.7"
          radius="xl"
          aria-label={`More actions for ${card.name}`}
          onClick={() => setOpened(true)}
        >
          <IconDots size={16} />
        </ActionIcon>
      )}
      <PrintingPicker
        opened={picking}
        onClose={picker.close}
        scryfallId={entry.scryfallId}
        cardName={card.name}
        currency={actions.currency}
        onPick={(id) => actions.onPrinting(entry, id)}
      />
    </>
  )
}
