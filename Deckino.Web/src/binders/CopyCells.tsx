import { Badge, Group, HoverCard, Text } from '@mantine/core'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { Icon } from '../components/Icon'
import { entryPrice, finishLabels, type DeckCard, type Finish } from '../decks/deck'
import { conditions, languageLabel, printingLabel, type Condition } from './binder'
import classes from './BinderPage.module.css'

// A binder row's cells, the same on the owner's page and the public one: how many, the card (a picture on hover),
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
      <img className={classes.thumb} src={card.smallImage ?? card.image ?? undefined} alt="" loading="lazy" />
      <span className={classes.name}>
        <HoverCard position="right" openDelay={150} disabled={!card.image}>
          <HoverCard.Target>
            <span className={classes.cardName}>{card.name}</span>
          </HoverCard.Target>
          <HoverCard.Dropdown p={0} className={classes.preview}>
            <CardImage src={card.image} alt={card.name} foil={finish !== 'nonfoil'} />
          </HoverCard.Dropdown>
        </HoverCard>
        <Text span size="xs" c="dimmed" className={classes.details}>
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
        <span className={classes.price}>{formatPrice(entryPrice({ finish, card }, currency), currency)}</span>
      </Group>
      {open && <Icon name="keyboard_arrow_down" size={18} className={classes.chevron} />}
    </>
  )
}
