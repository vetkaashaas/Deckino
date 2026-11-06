import { Badge, Group, Text } from '@mantine/core'
import { CardPreview } from '../components/CardPreview'
import { formatPrice, useCurrency } from '../components/currency'
import { Icon } from '../components/Icon'
import { entryPrice, finishLabels, type DeckCard, type Finish } from '../decks/deck'
import { conditions, languageLabel, printingLabel, type Condition } from './binder'
import classes from './BinderPage.module.css'

// A binder row's cells, the same on the owner's page and the public one: how many, the card (big while hovered),
// its printing and notes, and what's particular about the copies. `open`: the row opens the card panel.
export function CopyCells({
  count,
  card,
  finish,
  condition,
  language,
  notes,
  unchecked = false,
  open = false,
}: {
  count: number
  card: DeckCard
  finish: Finish
  condition: Condition
  language: string
  notes?: string | null
  unchecked?: boolean
  open?: boolean
}) {
  const [currency] = useCurrency()
  return (
    <>
      <span className={classes.count} aria-label={`${count} copies`}>
        {count}×
      </span>
      <img className={classes.thumb} src={card.smallImage ?? card.image ?? undefined} alt="" loading="lazy" data-preview />
      <CardPreview src={card.image} name={card.name} foil={finish !== 'nonfoil'} />
      <span className={classes.name}>
        <span className={classes.cardName} data-preview>
          {card.name}
        </span>
        <Text span size="xs" c="dimmed" className={classes.details} data-preview>
          {printingLabel(card)}
          {notes && <> · {notes}</>}
        </Text>
      </span>
      <Group gap={6} className={classes.badges}>
        {unchecked && (
          <Badge size="sm" color="warning" variant="light" title="Scanned in the app: the set may be a different one">
            Check printing
          </Badge>
        )}
        {finish !== 'nonfoil' && (
          <Badge size="sm" variant="gradient">
            {finishLabels[finish]}
          </Badge>
        )}
        <Badge size="sm" variant="default" title={conditions.find((c) => c.value === condition)?.label ?? condition}>
          {condition}
        </Badge>
        <Badge size="sm" variant="default">
          {languageLabel(language)}
        </Badge>
        <span className={classes.price} data-preview>
          {formatPrice(entryPrice({ finish, card }, currency), currency)}
        </span>
      </Group>
      {open && <Icon name="keyboard_arrow_down" size={18} className={classes.chevron} />}
    </>
  )
}
