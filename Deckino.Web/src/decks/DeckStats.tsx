import { Tooltip } from '@mantine/core'
import { ManaSymbols } from '../components/ManaSymbols'
import { deckStats, type DeckSections } from './deck'
import classes from './DeckStats.module.css'

const colorNames: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }

// The deck at a glance, like the stats strip on the big deck builders: the mana curve of its spells, the colours
// its costs ask for, and its card types. Each bar has a tooltip; the numbers are also written out for screen readers.
export function DeckStats({ deck }: { deck: DeckSections }) {
  const stats = deckStats(deck)
  const tallest = Math.max(1, ...stats.curve)
  const pipTotal = Object.values(stats.pips).reduce((a, b) => a + b, 0)
  const colors = Object.entries(stats.pips).filter(([, n]) => n > 0)

  return (
    <section className={classes.root} aria-label="Deck stats">
      <div className={classes.block}>
        <h3 className={classes.heading}>
          Mana curve <span className={classes.aside}>average {stats.averageManaValue.toFixed(2)}</span>
        </h3>
        <ol className={classes.curve} aria-label="Spells by mana value">
          {stats.curve.map((count, mv) => {
            const label = `${count} ${count === 1 ? 'spell' : 'spells'} at mana value ${mv === 7 ? '7 or more' : mv}`
            return (
              <Tooltip key={mv} label={label} withArrow openDelay={80}>
                <li className={classes.column} aria-label={label}>
                  <span className={classes.value}>{count || ''}</span>
                  <span className={classes.track}>
                    <span className={classes.bar} style={{ height: `${(count / tallest) * 100}%` }} />
                  </span>
                  <span className={classes.mv}>{mv === 7 ? '7+' : mv}</span>
                </li>
              </Tooltip>
            )
          })}
        </ol>
      </div>

      <div className={classes.block}>
        <h3 className={classes.heading}>
          Colours <span className={classes.aside}>{stats.lands} {stats.lands === 1 ? 'land' : 'lands'}</span>
        </h3>
        {colors.length === 0 ? (
          <p className={classes.none}>No coloured mana symbols yet.</p>
        ) : (
          <ul className={classes.list} aria-label="Coloured mana symbols">
            {colors.map(([c, n]) => {
              const share = Math.round((n / pipTotal) * 100)
              return (
                <li key={c} className={classes.pipRow} aria-label={`${colorNames[c]}: ${share}% of coloured symbols`}>
                  <span className={classes.symbol}>
                    <ManaSymbols text={`{${c}}`} />
                  </span>
                  <span className={classes.track} data-horizontal>
                    <span className={classes.bar} data-color={c} style={{ width: `${share}%` }} />
                  </span>
                  <span className={classes.share}>{share}%</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className={classes.block}>
        <h3 className={classes.heading}>Types</h3>
        {stats.types.length === 0 ? (
          <p className={classes.none}>No cards yet.</p>
        ) : (
          <dl className={classes.types}>
            {stats.types.map((t) => (
              <div key={t.label} className={classes.type}>
                <dt>{t.label}</dt>
                <dd>{t.count}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  )
}
