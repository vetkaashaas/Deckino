import { Stack, Text, Title } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Ambient } from '../components/Ambient'
import { FanContentNotice } from '../components/FanContentNotice'
import { CommanderOfTheDay } from '../landing/CommanderOfTheDay'
import classes from './AuthPage.module.css'

// The full-page layout shared by the sign-up, log-in and password pages, outside the site's header and footer:
// the form on one side, the brand and the Commander of the Day on the other (form only at phone width).
export function AuthPage({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  // Not just hidden at phone width: left out, so phones don't fetch the Commander of the Day's image.
  const wide = useMediaQuery('(min-width: 62em)', false, { getInitialValueInEffect: false })
  return (
    <div className={classes.root}>
      {wide && <aside className={classes.brand} aria-label="Commander of the Day">
        <Ambient />
        <Link to="/" className={`${classes.logo} ${classes.brandLogo}`} aria-label="Deckino home">
          <img src="/logo.svg" alt="Deckino" />
        </Link>
        <div className={classes.showcase}>
          <CommanderOfTheDay />
        </div>
        <Text className={classes.tagline}>Scan, collect, build and share your Magic cards.</Text>
      </aside>}

      <main className={classes.formSide}>
        <Link to="/" className={`${classes.logo} ${classes.phoneLogo}`} aria-label="Deckino home">
          <img src="/logo.svg" alt="Deckino" height={52} />
        </Link>
        <div className={classes.form}>
          <Stack gap="xs" mb="xl">
            <Title order={1} className={classes.title}>
              {title}
            </Title>
            {intro && <Text c="dimmed">{intro}</Text>}
          </Stack>
          {children}
        </div>
        <div className={classes.notice}>
          <FanContentNotice />
        </div>
      </main>
    </div>
  )
}
