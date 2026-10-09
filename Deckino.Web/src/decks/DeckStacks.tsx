import { CardImage } from '../components/CardImage'
import { CardMenu, type CardActions } from './CardMenu'
import { countCards, entryKey, groupByType, type DeckEntry, type SectionName } from './deck'
import classes from './DeckStacks.module.css'

export type StackActions = CardActions

// One card in a stack. Only its title bar shows until it's hovered or focused, when it rises over the cards below;
// a click or right-click opens its actions. Without actions (a public deck) it's only a picture.
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
        <CardMenu entry={entry} actions={actions} className={classes.button}>
          {face}
        </CardMenu>
      ) : (
        face
      )}
    </li>
  )
}

// A section as Moxfield's and Archidekt's "visual stacks": a column per card type, cards overlapping by their title
// bars. The commander section lays its one or two cards side by side.
export function DeckStacks({ section, entries, actions }: { section: SectionName; entries: DeckEntry[]; actions?: CardActions }) {
  const groups = section === 'commander' ? [{ label: '', entries }] : groupByType(entries)
  return (
    <div className={classes.columns} data-section={section}>
      {groups.map((group) => (
        <div key={group.label || 'all'} className={classes.column}>
          {group.label && (
            <h3 className={classes.title}>
              {group.label} <span className={classes.count}>{countCards(group.entries)}</span>
            </h3>
          )}
          <ul className={classes.stack} data-flat={section === 'commander' || undefined}>
            {group.entries.map((entry) => (
              <StackCard key={entryKey(entry)} entry={entry} actions={actions} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
