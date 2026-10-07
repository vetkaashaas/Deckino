import { Alert, Anchor, Button, Container, Group, Skeleton, Text, Title } from '@mantine/core'
import { IconFileImport } from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { getJson } from './api'
import type { Account } from './account/auth'
import type { BinderSummary } from './binders/binder'
import { BinderTile } from './binders/BinderTile'
import { CollectionValue } from './binders/CollectionValue'
import { ArtHeader } from './components/ArtHeader'
import { formatPrice, useCurrency } from './components/currency'
import { CurrencyToggle } from './components/CurrencyToggle'
import { tileGrid } from './components/Tile'
import type { DeckSummary } from './decks/deck'
import { anyFinishPrice } from './decks/deck'
import { DeckTile } from './decks/DeckTile'
import type { WantedCard } from './wishlist/WishlistPage'
import classes from './Dashboard.module.css'

const shownTiles = 4

interface Overview {
  decks: DeckSummary[]
  binders: BinderSummary[]
  wishlist: WantedCard[]
}

function Section({ title, to, children, actions }: { title: string; to: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className={classes.section} aria-label={title}>
      <Group justify="space-between" align="baseline" mb="md">
        <Title order={2}>
          <Anchor component={Link} to={to} c="inherit" underline="hover" inherit>
            {title}
          </Anchor>
        </Title>
        <Group gap="sm">{actions}</Group>
      </Group>
      {children}
    </section>
  )
}

// Where a signed-in user lands: their collection's value and movers, recent decks and binders, the wishlist.
export default function Dashboard({ account }: { account: Account }) {
  const [overview, setOverview] = useState<Overview | null>()
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    let current = true
    Promise.all([getJson<DeckSummary[]>('/api/decks'), getJson<BinderSummary[]>('/api/binders'), getJson<WantedCard[]>('/api/wishlist')])
      .then(([decks, binders, wishlist]) => current && setOverview({ decks, binders, wishlist }))
      .catch(() => current && setOverview(null))
    return () => {
      current = false
    }
  }, [])

  const wanted = overview?.wishlist.reduce((sum, w) => sum + w.quantity, 0) ?? 0
  const wishlistValue = overview?.wishlist.reduce((sum, w) => sum + (anyFinishPrice(w.card, currency) ?? 0) * w.quantity, 0) ?? 0

  return (
    <>
      <ArtHeader>
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={1}>Welcome back, {account.username}</Title>
            <Text c="dimmed" mt="xs">
              Your decks, binders and wishlist at a glance.
            </Text>
          </div>
          <CurrencyToggle currency={currency} onChange={setCurrency} />
        </Group>
      </ArtHeader>

      <Container size="lg">
        {overview === null && (
          <Alert color="red" title="Your dashboard didn't load" role="alert" mb="xl">
            Deckino didn't respond. Reload the page to try again.
          </Alert>
        )}
        {overview === undefined && (
          <div className={tileGrid} aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} height={180} radius="lg" />
            ))}
          </div>
        )}

        {overview && (
          <>
            {overview.binders.length > 0 && <CollectionValue currency={currency} />}

            <Section
              title="Your decks"
              to="/decks"
              actions={
                <Button component={Link} to="/decks/import" variant="subtle" size="xs" leftSection={<IconFileImport size={16} />}>
                  Import
                </Button>
              }
            >
              {overview.decks.length === 0 ? (
                <Text c="dimmed">No decks yet. Build one from the catalogue, or import a list you already have.</Text>
              ) : (
                <ul className={tileGrid} aria-label="Recent decks">
                  {overview.decks.slice(0, shownTiles).map((deck) => (
                    <li key={deck.id}>
                      <DeckTile deck={deck} to={`/decks/${deck.id}`} meta={`Updated ${new Date(deck.updatedAt).toLocaleDateString()}`} />
                    </li>
                  ))}
                </ul>
              )}
              {overview.decks.length > shownTiles && (
                <Anchor component={Link} to="/decks" size="sm" mt="sm" display="inline-block">
                  See all {overview.decks.length} decks
                </Anchor>
              )}
            </Section>

            <Section
              title="Your binders"
              to="/binders"
              actions={
                <Button component={Link} to="/binders/import" variant="subtle" size="xs" leftSection={<IconFileImport size={16} />}>
                  Import
                </Button>
              }
            >
              {overview.binders.length === 0 ? (
                <Text c="dimmed">No binders yet. Record the cards you own to see what they're worth and what your decks are missing.</Text>
              ) : (
                <ul className={tileGrid} aria-label="Recent binders">
                  {overview.binders.slice(0, shownTiles).map((binder) => (
                    <li key={binder.id}>
                      <BinderTile binder={binder} />
                    </li>
                  ))}
                </ul>
              )}
              {overview.binders.length > shownTiles && (
                <Anchor component={Link} to="/binders" size="sm" mt="sm" display="inline-block">
                  See all {overview.binders.length} binders
                </Anchor>
              )}
            </Section>

            <Section title="Your wishlist" to="/wishlist">
              <Text data-testid="dashboard-wishlist">
                {wanted === 0
                  ? 'Nothing on your wishlist. Compare a deck with your binders to see what it needs.'
                  : `${wanted} ${wanted === 1 ? 'card' : 'cards'} wanted · ≈ ${formatPrice(wishlistValue, currency)}`}
              </Text>
            </Section>
          </>
        )}
      </Container>
    </>
  )
}
