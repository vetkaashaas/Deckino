import { Container } from '@mantine/core'
import type { ReactNode } from 'react'
import classes from './ArtHeader.module.css'

// The top of a card-led page: the card's illustration, blurred and darkened, fading into the page
// behind the title. Without art it is a plain page header, so every page starts the same way.
export function ArtHeader({ art, children }: { art?: string | null; children: ReactNode }) {
  return (
    <div className={classes.root} data-has-art={art ? true : undefined}>
      {art && <div className={classes.art} style={{ backgroundImage: `url("${art}")` }} aria-hidden="true" />}
      <Container size="lg" className={classes.content}>
        {children}
      </Container>
    </div>
  )
}
