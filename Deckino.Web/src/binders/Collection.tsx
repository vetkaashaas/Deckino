import { Alert, Button, Container, Group, Modal, Skeleton, Stack, Text, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { useApiSubmit } from '../account/forms'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { formatPrice, signed, useCurrency, type Currency } from '../components/currency'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { PageTabs } from '../components/PageTabs'
import { PageTitle } from '../components/PageTitle'
import { Tile, tileGrid } from '../components/Tile'
import { finishLabels, wantedValue } from '../decks/deck'
import type * as Api from '../generated'
import type { WantedCard } from '../wishlist/WishlistPage'
import { BinderTile } from './BinderTile'
import type { BinderSummary } from './binder'
import { CollectionValue } from './CollectionValue'
import classes from './Collection.module.css'

export function NewBinder({ label = 'New binder', variant = 'gradient' }: { label?: string; variant?: 'gradient' | 'default' }) {
  const navigate = useNavigate()
  const [open, dialog] = useDisclosure()
  const form = useForm({
    initialValues: { name: '' },
    validate: { name: (value) => (value.trim() ? null : 'Give the binder a name') },
  })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <>
      <Button variant={variant} leftSection={<Icon name="add" size={18} />} onClick={dialog.open}>
        {label}
      </Button>
      <Modal opened={open} onClose={dialog.close} title="New binder" centered>
        <form
          onSubmit={submit(async (values) => {
            const binder = await sendJson('POST', '/api/binders', values)
            navigate(`/binders/${binder.id}`)
          })}
          noValidate
        >
          <Stack gap="md">
            {error && <Alert color="danger" role="alert">{error}</Alert>}
            <TextInput label="Binder name" maxLength={100} data-autofocus {...form.getInputProps('name')} />
            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.close}>
                Cancel
              </Button>
              <Button type="submit" variant="gradient" loading={submitting}>
                Create binder
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  )
}

// The app's Collection tab: the value, then the binders (and the wishlist after them: cards you want, not ones you
// have) at /collection, and how your cards' prices moved this week at /collection/prices.
export default function Collection() {
  const { account } = useAuth()
  const location = useLocation()
  const prices = location.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/prices')
  const [binders, setBinders] = useState<BinderSummary[] | null>()
  const [currency] = useCurrency()

  useEffect(() => {
    if (!account) return
    getJson('/api/binders')
      .then(setBinders)
      .catch(() => setBinders(null))
  }, [account])

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  const some = binders && binders.length > 0
  return (
    <>
      <ArtHeader>
        <Group justify="space-between" align="flex-end">
          <div>
            <PageTitle>Collection</PageTitle>
            <Text c="dimmed" mt="xs">
              The cards you own, in binders. Private unless you share a binder.
            </Text>
          </div>
          <Group gap="sm">
            <Button component={Link} to="/binders/import" variant="default" leftSection={<Icon name="playlist_add" size={18} />}>
              Import
            </Button>
            {some && !prices && <NewBinder />}
          </Group>
        </Group>
      </ArtHeader>

      <Container size="lg">
        {some && <CollectionValue currency={currency} movers={false} />}
        <PageTabs
          label="Collection"
          tabs={[
            { to: '/collection', label: 'Binders' },
            { to: '/collection/prices', label: 'Prices' },
          ]}
        />
        {prices ? <Movers currency={currency} /> : <Binders binders={binders} currency={currency} />}
      </Container>
    </>
  )
}

function Binders({ binders, currency }: { binders: BinderSummary[] | null | undefined; currency: Currency }) {
  if (binders === undefined) {
    return (
      <div className={tileGrid} aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={180} radius="lg" />
        ))}
      </div>
    )
  }
  if (binders === null) {
    return (
      <Alert color="danger" title="Your binders didn't load" role="alert">
        Deckino didn't respond. Reload the page to try again.
      </Alert>
    )
  }
  return (
    <>
      {binders.length === 0 ? (
        <EmptyState title="Make your first binder" action={<NewBinder label="New binder" />}>
          A binder holds your cards: one for trades, one per box, whatever suits you.
        </EmptyState>
      ) : (
        <ul className={tileGrid} aria-label="Binders">
          {binders.map((binder) => (
            <li key={binder.id}>
              <BinderTile binder={binder} />
            </li>
          ))}
        </ul>
      )}
      <div className={`${tileGrid} ${classes.wishlist}`}>
        <WishlistTile currency={currency} />
      </div>
    </>
  )
}

// The wishlist, after the binders: how many cards you want and what they'd cost.
function WishlistTile({ currency }: { currency: Currency }) {
  const [wanted, setWanted] = useState<WantedCard[] | null>()

  useEffect(() => {
    getJson('/api/wishlist')
      .then(setWanted)
      .catch(() => setWanted(null))
  }, [])

  const count = wanted?.reduce((sum, w) => sum + w.quantity, 0) ?? 0
  const value = wantedValue(wanted, currency)
  const first = wanted?.[0]?.card
  return (
    <Tile
      to="/wishlist"
      cover={first?.artCrop ?? null}
      name="Wishlist"
      meta={
        wanted === undefined
          ? ''
          : wanted === null
            ? "Didn't load"
            : count === 0
              ? 'Nothing on it yet'
              : `${count} ${count === 1 ? 'card' : 'cards'} wanted · ≈ ${formatPrice(value, currency)}`
      }
    />
  )
}

type PriceMover = Api.PriceMover

// Every card of yours whose price changed this week, by how much it moved your total, a page at a time.
function Movers({ currency }: { currency: Currency }) {
  const [movers, setMovers] = useState<PriceMover[]>([])
  const [page, setPage] = useState(1)
  const [more, setMore] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0) // a retry of the same page

  useEffect(() => {
    let current = true
    getJson(`/api/collection/movers?currency=${currency}&page=${page}`)
      .then((result) => {
        if (!current) return
        setMovers((shown) => (page === 1 ? result.movers : [...shown, ...result.movers]))
        setMore(result.hasMore)
        setState('ready')
      })
      .catch(() => current && setState('failed'))
    return () => {
      current = false
    }
  }, [currency, page, attempt])

  if (state === 'loading' && movers.length === 0) {
    return (
      <Stack gap="xs" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={56} />
        ))}
      </Stack>
    )
  }
  if (state === 'failed' && movers.length === 0) {
    return (
      <Alert color="danger" title="The price changes didn't load" role="alert">
        Deckino didn't respond. Reload the page to try again.
      </Alert>
    )
  }
  if (movers.length === 0) return <Text c="dimmed">None of your cards changed price this week.</Text>

  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        This week's changes to your cards, biggest first.
      </Text>
      <ul className={classes.movers} aria-label="Price changes">
        {movers.map((m) => (
          <li key={`${m.card.id}:${m.finish}`} aria-label={m.card.name}>
            <Link to={`/cards/${m.card.id}`} className={classes.mover}>
              <CardImage src={m.card.smallImage ?? m.card.image} alt="" lazy className={classes.thumb} />
              <span className={classes.what}>
                <span className={classes.name}>{m.card.name}</span>
                <Text span size="sm" c="dimmed">
                  {[
                    `${m.count > 1 ? `${m.count} × ` : ''}${formatPrice(m.now, currency)}`,
                    m.finish !== 'nonfoil' ? finishLabels[m.finish] : null,
                    m.card.setName,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </span>
              <span className={classes.change} data-down={m.change < 0 || undefined}>
                {signed(m.change, currency)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {more && (
        <Button
          variant="default"
          mt="md"
          loading={state === 'loading'}
          onClick={() => {
            setState('loading')
            if (state === 'failed') setAttempt((a) => a + 1)
            else setPage((p) => p + 1)
          }}
        >
          {state === 'failed' ? "Couldn't load more. Try again" : 'Show more'}
        </Button>
      )}
    </>
  )
}
