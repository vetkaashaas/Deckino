import { Alert, Anchor, Button, Container, Group, Loader, Skeleton, Text, Title } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { getJson } from './api'
import type { Account } from './account/auth'
import type { BinderSummary } from './binders/binder'
import { CollectionValue } from './binders/CollectionValue'
import { ArtHeader } from './components/ArtHeader'
import { type Currency, useCurrency } from './components/currency'
import { Icon } from './components/Icon'
import { MoverRow, moverList, RisingFalling } from './components/MoverRow'
import { PageTitle } from './components/PageTitle'
import { timeAgo } from './components/timeAgo'
import { tileGrid } from './components/Tile'
import { DeckTile } from './decks/DeckTile'
import type * as Api from './generated'
import classes from './Dashboard.module.css'

// Home, as in the app: what's new for you, value first; what you have is on Collection and Decks. With no cards yet,
// adding the first ones takes the value's place, with other players' decks to show what Deckino is for.
export default function Dashboard({ account }: { account: Account }) {
  const [binders, setBinders] = useState<BinderSummary[] | null>()
  const [currency] = useCurrency()

  useEffect(() => {
    let current = true
    getJson('/api/binders')
      .then((b) => current && setBinders(b))
      .catch(() => current && setBinders(null))
    return () => {
      current = false
    }
  }, [])

  const cards = binders?.reduce((sum, b) => sum + b.cardCount, 0) ?? 0
  return (
    <>
      <ArtHeader>
        <PageTitle>Hi, {account.username}</PageTitle>
      </ArtHeader>

      <Container size="lg">
        {binders === null && (
          <Alert color="danger" title="Your collection didn't load" role="alert" mb="xl">
            Deckino didn't respond. Reload the page to try again.
          </Alert>
        )}
        {binders === undefined && <Skeleton height={120} width={320} radius="lg" aria-busy="true" />}
        {binders && cards > 0 && (
          <div className={classes.home}>
            <CollectionValue currency={currency} cards={cards} to="/collection" line movers={3} />
            <Movers currency={currency} />
          </div>
        )}
        {binders && cards === 0 && (
          <>
            <div className={classes.home}>
              <FirstCards to={binders[0] ? `/binders/${binders[0].id}` : '/collection'} />
              <Movers currency={currency} top={3} />
            </div>
            <OthersDecks username={account.username} />
          </>
        )}
      </Container>
    </>
  )
}

type Mover = Api.PriceMover

// This week's biggest price moves across the market, Rising or Falling. As in the app, a few show and the rest scroll
// in their own box (the page stays short), the next page loading as the end comes near. With `top`, only that many
// and no box. Nothing moved yet (no prices from a week ago): no section.
function Movers({ currency, top }: { currency: Currency; top?: number }) {
  const [falling, setFalling] = useState(false)
  const key = `${currency}:${falling}`
  const [list, setList] = useState<{ key: string; movers: Mover[]; hasMore: boolean; page: number } | null>()
  const [loadingMore, setLoadingMore] = useState(false)
  const [failedMore, setFailedMore] = useState(false)
  const loading = useRef(false) // scroll events come faster than state updates

  useEffect(() => {
    let current = true
    getJson(`/api/prices/movers?currency=${currency}&falling=${falling}&page=1`)
      .then((r) => current && setList({ key, movers: r.movers, hasMore: r.hasMore, page: 1 }))
      .catch(() => current && setList(null))
    return () => {
      current = false
    }
  }, [currency, falling, key])

  async function more() {
    if (!shown?.hasMore || loading.current) return
    loading.current = true
    setLoadingMore(true)
    setFailedMore(false)
    try {
      const page = shown.page + 1
      const r = await getJson(`/api/prices/movers?currency=${currency}&falling=${falling}&page=${page}`)
      setList((l) => (l && l.key === key ? { key, movers: [...l.movers, ...r.movers], hasMore: r.hasMore, page } : l))
    } catch {
      setFailedMore(true) // a button at the end, to try again
    } finally {
      loading.current = false
      setLoadingMore(false)
    }
  }

  const shown = list && list.key === key ? list : undefined
  const nearEnd = (box: HTMLElement) => box.scrollHeight - box.scrollTop - box.clientHeight < 200
  if (list === null || (!falling && shown?.movers.length === 0)) return null
  const movers = top ? shown?.movers.slice(0, top) : shown?.movers
  return (
    <section aria-label="Market movers this week">
      <Group justify="space-between" align="center" mb="sm">
        <Title order={2} size="h3">
          Market movers this week
        </Title>
        <RisingFalling falling={falling} onChange={setFalling} label="Market movers" />
      </Group>
      {movers?.length === 0 ? (
        <Text c="dimmed">No card's price {falling ? 'fell' : 'rose'} much this week.</Text>
      ) : movers ? (
        <div className={top ? undefined : classes.scroll} onScroll={top ? undefined : (e) => !failedMore && nearEnd(e.currentTarget) && void more()}>
          <ul className={moverList} aria-label={falling ? 'Falling cards' : 'Rising cards'}>
            {movers.map((m) => (
              <MoverRow key={`${m.card.id}:${m.finish}`} mover={m} currency={currency} market />
            ))}
          </ul>
          {!top && loadingMore && <Loader size="sm" mx="auto" my="md" display="block" />}
          {!top && failedMore && (
            <Button variant="default" fullWidth my="sm" onClick={more}>
              Couldn't load more. Try again
            </Button>
          )}
        </div>
      ) : (
        <Skeleton height={240} radius="md" aria-busy="true" />
      )}
    </section>
  )
}

// No cards yet: the one thing to do. (The app scans; the website adds from a search, in a binder.)
function FirstCards({ to }: { to: string }) {
  return (
    <section className={classes.first} aria-label="Add your first cards">
      <span className={classes.firstIcon}>
        <Icon name="library_add" size={34} />
      </span>
      <Title order={2}>Add your first cards</Title>
      <Text c="dimmed" maw={340}>
        Search for a card and put it in a binder. You'll see what your collection is worth, and what your decks still need.
      </Text>
      <Button component={Link} to={to} size="lg" variant="gradient" fullWidth leftSection={<Icon name="add" size={20} />}>
        Add cards
      </Button>
    </section>
  )
}

// The newest public decks that aren't yours; "See all" opens them on Decks.
function OthersDecks({ username }: { username: string }) {
  const [decks, setDecks] = useState<Api.PublicDeckSearchResult['decks']>([])

  useEffect(() => {
    let current = true
    getJson('/api/public/decks')
      .then((r) => current && setDecks(r.decks))
      .catch(() => {}) // only a showcase: nothing shows
    return () => {
      current = false
    }
  }, [])

  const others = decks.filter(({ owner }) => owner !== username).slice(0, 3) // one row of tiles
  if (others.length === 0) return null
  return (
    <section className={classes.others} aria-label="Decks from other players">
      <Group justify="space-between" align="baseline" mb="md">
        <Title order={2} size="h3">
          Decks from other players
        </Title>
        <Anchor component={Link} to="/browse" size="sm" fw={600}>
          See all
        </Anchor>
      </Group>
      <ul className={tileGrid}>
        {others.map(({ deck, owner }) => (
          <li key={deck.id}>
            <DeckTile deck={deck} to={`/deck/${deck.id}`} meta={`by ${owner} · Updated ${timeAgo(deck.updatedAt)}`} />
          </li>
        ))}
      </ul>
    </section>
  )
}
