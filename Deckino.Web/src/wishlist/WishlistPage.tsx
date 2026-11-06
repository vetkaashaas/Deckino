import { Alert, Anchor, Container, HoverCard, Skeleton, Text, Title, UnstyledButton } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { printingLabel } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { CardPanel } from '../components/CardPanel'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols } from '../components/ManaSymbols'
import { formatPrice, useCurrency } from '../components/currency'
import { showToast } from '../components/toast'
import { anyFinishPrice, wantedValue } from '../decks/deck'
import type * as Api from '../generated'
import classes from './WishlistPage.module.css'
import { Icon } from '../components/Icon'

// Shape returned by Deckino.Api/Wishlist/WishlistEndpoints.cs.
export type WantedCard = Api.WantedCardDetail

// The user's wishlist: the printings they want and how many. A row opens the card panel; every change saves
// straight away.
export default function WishlistPage() {
  const { account } = useAuth()
  const location = useLocation()
  const [wanted, setWanted] = useState<WantedCard[] | null>()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // the entry open in the card panel
  const [currency] = useCurrency()

  useEffect(() => {
    if (!account) return
    getJson('/api/wishlist')
      .then(setWanted)
      .catch(() => setWanted(null))
  }, [account])

  // Changes go to the API one at a time, in order. Only the newest change's answer is shown; an older one would
  // undo what's on screen. A failure shows above the list, or (quiet) only rejects, for the card panel to show.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const latest = useRef(0)
  function run(save: () => Promise<WantedCard[]>, quiet = false): Promise<void> {
    const change = ++latest.current
    setError(null)
    const done = queue.current.then(async () => {
      try {
        const list = await save()
        if (change === latest.current) setWanted(list)
      } catch (e) {
        if (!quiet) setError(e instanceof ApiError ? e.message : "Deckino didn't respond. Try again.")
        // Show the list as it really is now.
        await getJson('/api/wishlist').then(setWanted).catch(() => {})
        throw e
      }
    })
    queue.current = done.catch(() => {})
    return done
  }

  // Off the list, and back on with Undo.
  async function remove(entry: WantedCard) {
    try {
      await run(() => sendJson('DELETE', `/api/wishlist/${entry.id}`))
    } catch {
      return
    }
    showToast({
      message: `Removed ${entry.card.name}`,
      undo: () => void run(() => sendJson('POST', '/api/wishlist', { scryfallId: entry.scryfallId, quantity: entry.quantity })).catch(() => {}),
    })
  }

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  const count = wanted?.reduce((sum, w) => sum + w.quantity, 0) ?? 0
  const value = wantedValue(wanted, currency)
  const open = wanted?.find((w) => w.id === editing)
  return (
    <>
      <ArtHeader>
        <Anchor component={Link} to="/collection" size="sm" c="dark.1">
          Collection
        </Anchor>
        <Title order={1} mt={6}>
          Your wishlist
        </Title>
        <Text c="dimmed" mt="xs" data-testid="wishlist-count">
          {wanted ? `${count} ${count === 1 ? 'card' : 'cards'} wanted. ` : ''}Only you see your wishlist.
        </Text>
        {wanted && wanted.length > 0 && (
          <Text mt={4} data-testid="wishlist-value">
            ≈ {formatPrice(value, currency)} to buy it all
          </Text>
        )}
      </ArtHeader>

      <Container size="lg">
        <div className={classes.searchRow}>
          <div className={classes.search}>
            <CardPicker
              label="Add a card"
              placeholder='Add a card: type "4 sol ring" to want four'
              onPick={(scryfallId, quantity) => void run(() => sendJson('POST', '/api/wishlist', { scryfallId, quantity })).catch(() => {})}
            />
          </div>
        </div>

        {error && (
          <Alert color="danger" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {wanted === undefined && <Skeleton height={200} aria-busy="true" />}
        {wanted === null && (
          <Alert color="danger" title="Your wishlist didn't load" role="alert">
            Deckino didn't respond. Reload the page to try again.
          </Alert>
        )}
        {wanted?.length === 0 && (
          <EmptyState title="Nothing on your wishlist">
            Search for a card above, or compare a deck with your collection and add what's missing.
          </EmptyState>
        )}
        {wanted && wanted.length > 0 && (
          <ul className={classes.rows} aria-label="Wishlist">
            {wanted.map((entry) => (
              <li key={entry.id} aria-label={entry.card.name}>
                <UnstyledButton className={classes.row} onClick={() => setEditing(entry.id)} aria-label={`Edit ${entry.card.name}`}>
                  <span className={classes.quantity} data-testid="quantity">
                    {entry.quantity}×
                  </span>
                  <img className={classes.thumb} src={entry.card.smallImage ?? entry.card.image ?? undefined} alt="" loading="lazy" />
                  <span className={classes.name}>
                    <HoverCard position="right" openDelay={150} disabled={!entry.card.image}>
                      <HoverCard.Target>
                        <span className={classes.cardName}>{entry.card.name}</span>
                      </HoverCard.Target>
                      <HoverCard.Dropdown p={0} className={classes.preview}>
                        <CardImage src={entry.card.image} alt={entry.card.name} />
                      </HoverCard.Dropdown>
                    </HoverCard>
                    <Text span size="xs" c="dimmed" className={classes.printing} data-testid="printing">
                      {printingLabel(entry.card)}
                    </Text>
                  </span>
                  <span className={classes.mana}>
                    <ManaSymbols text={entry.card.manaCost} />
                  </span>
                  <span className={classes.price}>{formatPrice(anyFinishPrice(entry.card, currency), currency)}</span>
                  <Icon name="keyboard_arrow_down" size={18} className={classes.chevron} />
                </UnstyledButton>
              </li>
            ))}
          </ul>
        )}
      </Container>

      {open && (
        <CardPanel
          key={open.id}
          initial={{ card: open.card, copies: open.quantity }}
          removeLabel="Remove from wishlist"
          onSave={async ({ card, copies }) => {
            await run(() => sendJson('PUT', `/api/wishlist/${open.id}`, { scryfallId: card.id, quantity: copies }), true)
            setEditing(null)
          }}
          onRemove={() => {
            setEditing(null)
            void remove(open)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}
