import { Tooltip } from '@mantine/core'
import type { DeckEntry } from '../decks/deck'
import stats from '../decks/DeckStats.module.css'
import classes from './OpeningOdds.module.css'
import { openingOdds, percent, turns } from './odds'

// "How it runs": the odds of the opening hand and the early land drops, beside the deck's other stats and in the
// playtest. Worked out from the mainboard alone; changes in the builder show at once. Multiplayer Commander draws on
// turn 1 (Playtest's default too), so there that row comes first; two-player formats go by play or draw.
export function OpeningOdds({ mainboard, format, stacked = false }: { mainboard: DeckEntry[]; format: string; stacked?: boolean }) {
  const commander = format === 'commander'
  const odds = openingOdds(mainboard)
  if (odds.cards < 7) return <p className={stats.none}>Opening-hand odds need at least 7 cards in the mainboard.</p>
  const tallest = Math.max(...odds.landsInHand)
  const play = odds.onCurve(true)
  const draw = odds.onCurve(false)
  return (
    <div className={classes.root} data-stacked={stacked || undefined} data-testid="opening-odds">
      <div>
        <h3 className={stats.heading}>
          Lands in the opening hand <span className={stats.aside}>2–5 lands: {percent(odds.keepable)}</span>
        </h3>
        <ol className={stats.curve} aria-label="Lands in the opening 7">
          {odds.landsInHand.map((p, k) => {
            const label = `${percent(p)} of opening hands have ${k} ${k === 1 ? 'land' : 'lands'}`
            return (
              <Tooltip key={k} label={label} withArrow openDelay={80}>
                <li className={stats.column} aria-label={label}>
                  <span className={stats.value}>{p >= 0.005 ? percent(p) : ''}</span>
                  <span className={stats.track}>
                    <span className={stats.bar} data-muted={k < 2 || k > 5 || undefined} style={{ height: `${(p / tallest) * 100}%` }} />
                  </span>
                  <span className={stats.mv}>{k}</span>
                </li>
              </Tooltip>
            )
          })}
        </ol>
      </div>

      <div>
        <h3 className={stats.heading}>Land drop on curve</h3>
        <table className={classes.table}>
          <thead>
            <tr>
              <th scope="col">Turn</th>
              {turns.map((t) => (
                <th key={t} scope="col">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(commander
              ? ([
                  ['Draw on turn 1', draw],
                  ['No draw on turn 1', play],
                ] as const)
              : ([
                  ['On the play', play],
                  ['On the draw', draw],
                ] as const)
            ).map(([label, row]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {row.map((p, i) => (
                  <td key={i} data-level={p >= 0.8 ? 'good' : p >= 0.5 ? 'fair' : 'poor'}>
                    {percent(p)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <dl className={classes.facts}>
          <div>
            <dt>A spell of mana value 2 or less by turn 2</dt>
            <dd>
              {commander
                ? `${percent(odds.earlyPlay(false))} drawing on turn 1 · ${percent(odds.earlyPlay(true))} without`
                : `${percent(odds.earlyPlay(true))} on the play · ${percent(odds.earlyPlay(false))} on the draw`}
            </dd>
          </div>
          <div>
            <dt>Mulligans, keeping hands of 2–5 lands</dt>
            <dd>{odds.mulligans === null ? 'Every hand is a mulligan' : `About ${odds.mulligans.toFixed(2)} a game`}</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
