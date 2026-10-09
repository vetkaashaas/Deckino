import { timeAgo } from '../components/timeAgo'
import { Badge } from '@mantine/core'
import { Tile } from '../components/Tile'
import type { BinderSummary } from './binder'

export function BinderTile({ binder }: { binder: BinderSummary }) {
  return (
    <Tile
      to={`/binders/${binder.id}`}
      cover={binder.cover}
      name={binder.name}
      badges={
        <>
          {binder.isPublic && <Badge variant="light">Public</Badge>}
          {binder.isSelling && <Badge variant="gradient">Selling</Badge>}
        </>
      }
      meta={`${binder.cardCount} ${binder.cardCount === 1 ? 'card' : 'cards'} · Updated ${timeAgo(binder.updatedAt)}`}
    />
  )
}
