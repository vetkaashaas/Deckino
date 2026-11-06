import { UnstyledButton } from '@mantine/core'
import type { ReactNode } from 'react'
import type { DeckEntry } from './deck'

// What can be done to a card in the stacks and gallery views: open it in the card panel, and (in the gallery) one
// copy more or fewer. The deck page decides what's allowed.
export interface CardActions {
  canAdd: (entry: DeckEntry) => boolean
  onQuantity: (entry: DeckEntry, quantity: number) => void
  onEdit: (entry: DeckEntry) => void
}

// A card picture that opens the card panel.
export function CardButton({ entry, actions, className, children }: { entry: DeckEntry; actions: CardActions; className?: string; children: ReactNode }) {
  return (
    <UnstyledButton className={className} aria-label={`Edit ${entry.card.name}`} onClick={() => actions.onEdit(entry)}>
      {children}
    </UnstyledButton>
  )
}
