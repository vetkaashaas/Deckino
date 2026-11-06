import { Title } from '@mantine/core'
import type { ReactNode } from 'react'
import classes from './PageTitle.module.css'

// A section's page title (Home, Cards, Collection, Decks): the mark in the wordmark's gradient, then the words,
// as on the app's tab pages.
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <Title order={1} className={classes.title}>
      <span className={classes.star} aria-hidden="true" />
      {children}
    </Title>
  )
}
