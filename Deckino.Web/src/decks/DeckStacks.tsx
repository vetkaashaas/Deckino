import { CardImage } from '../components/CardImage'
import { CardButton, type CardActions } from './CardButton'
import { arrangeSection, countCards, entryKey, jumpId, type DeckEntry, type DeckOrder, type SectionName } from './deck'
import { TypeLabel } from './DeckParts'
import classes from './DeckStacks.module.css'

export type StackActions = CardActions

// One card in a stack. Only its title bar shows until it's hovered or focused, when it rises over the cards below;
// a click opens it in the card panel. Without actions (a public deck) it's only a picture.
function StackCard({ entry, actions }: { entry: DeckEntry; actions?: CardActions }) {
  const { card } = entry
  const face = (
    <>
      <CardImage src={card.image} alt={card.name} foil={entry.finish !== 'nonfoil'} lazy />
      {entry.quantity > 1 && <span className={classes.quantity}>{entry.quantity}×</span>}
    </>
  )
  return (
    <li className={classes.card} aria-label={card.name}>
      {actions ? (
        <CardButton entry={entry} actions={actions} className={classes.button}>
          {face}
        </CardButton>
      ) : (
        face
      )}
    </li>
  )
}

// A section as Moxfield's and Archidekt's "visual stacks": a column per card type, cards overlapping by their title
// bars. Without groups (always for the commander) the cards lie side by side instead of in one endless column.
export function DeckStacks({ section, entries, order, actions }: { section: SectionName; entries: DeckEntry[]; order: DeckOrder; actions?: CardActions }) {
  const groups = arrangeSection(section, entries, order)
  const flat = groups.length === 1 && !groups[0].label
  return (
    <div className={classes.columns} data-flat={flat || undefined}>
      {groups.map((group) => (
        <div key={group.label || 'all'} className={classes.column}>
          {group.label && (
            <h3 id={jumpId(section, group.label)} className={classes.title}>
              <TypeLabel label={group.label} size={16} /> <span className={classes.count}>{countCards(group.entries)}</span>
            </h3>
          )}
          <ul className={classes.stack} data-flat={flat || undefined}>
            {group.entries.map((entry) => (
              <StackCard key={entryKey(entry)} entry={entry} actions={actions} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
