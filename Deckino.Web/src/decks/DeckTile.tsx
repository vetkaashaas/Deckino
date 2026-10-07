import { Badge } from '@mantine/core'
import { ManaSymbols } from '../components/ManaSymbols'
import { Tile, tilePips } from '../components/Tile'
import { formatLabel, type DeckSummary } from './deck'

export function DeckTile({ deck, to, meta }: { deck: DeckSummary; to: string; meta: string }) {
  return (
    <Tile
      to={to}
      cover={deck.cover}
      name={deck.name}
      badges={
        <>
          <Badge variant="light">{formatLabel(deck.format)}</Badge>
          {deck.colorIdentity.length > 0 && (
            <span className={tilePips}>
              <ManaSymbols text={deck.colorIdentity.map((c) => `{${c}}`).join('')} />
            </span>
          )}
        </>
      }
      meta={`${deck.cardCount} ${deck.cardCount === 1 ? 'card' : 'cards'} · ${meta}`}
    />
  )
}
