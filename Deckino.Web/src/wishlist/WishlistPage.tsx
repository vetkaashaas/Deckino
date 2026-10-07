import { ActionIcon, Alert, Container, HoverCard, NumberInput, Skeleton, Text, Title } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { CardPicker } from '../cards/CardPicker'
import { PrintingSelect } from '../cards/PrintingSelect'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols } from '../components/ManaSymbols'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { anyFinishPrice, type DeckCard } from '../decks/deck'
import classes from './WishlistPage.module.css'

// Shape returned by Deckino.Api/Wishlist/WishlistEndpoints.cs.
export interface WantedCard {
  id: string
  scryfallId: string
  quantity: number
  card: DeckCard
}

// The user's wishlist: the printings they want and how many. Every change saves straight away.
export default function WishlistPage() {
  const { account } = useAuth()
  const location = useLocation()
  const [wanted, setWanted] = useState<WantedCard[] | null>()
  const [error, setError] = useState<string | null>(null)
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    if (!account) return
    getJson<WantedCard[]>('/api/wishlist')
      .then(setWanted)
      .catch(() => setWanted(null))
  }, [account])

  // Changes go to the API one at a time, in order, so typing "12" saves 1 then 12 and never ends on 1.
  // Only the newest change's answer is shown; an older one would undo what's on screen.
  const queue = useRef(Promise.resolve())
  const latest = useRef(0)
  function run(method: string, url: string, body?: unknown) {
    const change = ++latest.current
    setError(null)
    queue.current = queue.current.then(async () => {
      try {
        const list = await sendJson<WantedCard[]>(method, url, body)
        if (change === latest.current) setWanted(list)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Deckino didn't respond. Try again.")
        // Show the list as it really is now.
        await getJson<WantedCard[]>('/api/wishlist').then(setWanted).catch(() => {})
      }
    })
  }

  function setQuantity(entry: WantedCard, quantity: number) {
    setWanted((list) => list?.map((w) => (w.id === entry.id ? { ...w, quantity } : w)))
    run('PUT', `/api/wishlist/${entry.id}`, { quantity })
  }

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  const count = wanted?.reduce((sum, w) => sum + w.quantity, 0) ?? 0
  const value = wanted?.reduce((sum, w) => sum + (anyFinishPrice(w.card, currency) ?? 0) * w.quantity, 0) ?? 0
  return (
    <>
      <ArtHeader>
        <Title order={1}>Your wishlist</Title>
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
              placeholder="Add a card to your wishlist"
              onPick={(scryfallId) => run('POST', '/api/wishlist', { scryfallId, quantity: 1 })}
            />
          </div>
          <CurrencyToggle currency={currency} onChange={setCurrency} />
        </div>

        {error && (
          <Alert color="red" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {wanted === undefined && <Skeleton height={200} aria-busy="true" />}
        {wanted === null && (
          <Alert color="red" title="Your wishlist didn't load" role="alert">
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
              <li key={entry.id} className={classes.row} aria-label={entry.card.name}>
                <NumberInput
                  aria-label={`Quantity of ${entry.card.name}`}
                  size="xs"
                  className={classes.quantity}
                  min={1}
                  max={99}
                  clampBehavior="strict"
                  allowDecimal={false}
                  allowNegative={false}
                  value={entry.quantity}
                  onChange={(v) => typeof v === 'number' && v >= 1 && setQuantity(entry, v)}
                />
                <HoverCard position="right" openDelay={150} disabled={!entry.card.image}>
                  <HoverCard.Target>
                    <span className={classes.name}>{entry.card.name}</span>
                  </HoverCard.Target>
                  <HoverCard.Dropdown p={0} className={classes.preview}>
                    <CardImage src={entry.card.image} alt={entry.card.name} />
                  </HoverCard.Dropdown>
                </HoverCard>
                <span className={classes.mana}>
                  <ManaSymbols text={entry.card.manaCost} />
                </span>
                <span className={classes.price}>{formatPrice(anyFinishPrice(entry.card, currency), currency)}</span>
                <PrintingSelect
                  entry={entry}
                  className={classes.printing}
                  onPick={(scryfallId) => run('PUT', `/api/wishlist/${entry.id}`, { scryfallId })}
                />
                <ActionIcon
                  className={classes.remove}
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${entry.card.name}`}
                  onClick={() => run('DELETE', `/api/wishlist/${entry.id}`)}
                >
                  <IconTrash size={18} />
                </ActionIcon>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  )
}
