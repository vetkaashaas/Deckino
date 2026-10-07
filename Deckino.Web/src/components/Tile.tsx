import { Group, Text } from '@mantine/core'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import classes from './Tile.module.css'

// A deck or binder in a grid: the cover art on top, fading into its badges, name and details.
export function Tile({ to, cover, badges, name, meta }: { to: string; cover: string | null; badges?: ReactNode; name: string; meta: ReactNode }) {
  return (
    <Link to={to} className={classes.tile}>
      <span className={classes.cover} style={cover ? { backgroundImage: `url("${cover}")` } : undefined} aria-hidden="true" />
      <span className={classes.body}>
        <Group gap="xs" mih={20}>
          {badges}
        </Group>
        <span className={classes.name}>{name}</span>
        <Text component="span" size="sm" c="dimmed">
          {meta}
        </Text>
      </span>
    </Link>
  )
}

export const tileGrid = classes.grid
export const tilePips = classes.pips
