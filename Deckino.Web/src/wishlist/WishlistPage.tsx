import { Alert, CloseButton, Skeleton, Text, TextInput, UnstyledButton } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useEffect, useRef, useState } from 'react'
import { ApiError, getJson, sendJson } from '../api'
import { printingLabel } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { CardPreview } from '../components/CardPreview'
import { CardPanel } from '../components/CardPanel'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols } from '../components/ManaSymbols'
import { formatPrice, useCurrency } from '../components/currency'
import { showToast } from '../components/toast'
import { sticky, useStuck } from '../components/sticky'
import { anyFinishPrice, wantedValue } from '../decks/deck'
import type * as Api from '../generated'
import classes from './WishlistPage.module.css'
import { Icon } from '../components/Icon'

// Shape returned by Deckino.Api/Wishlist/WishlistEndpoints.cs.
export type WantedCard = Api.WantedCardDetail

// The user's wishlist, Collection's third tab (/wishlist): the printings they want and how many. A row opens the
// card panel; every change saves straight away. Above the cards, one bar that stays on screen: a filter for the
// list, the add box, and how many cards and what they'd cost.
export function Wishlist() {
  const [wanted, setWanted] = useState<WantedCard[] | null>()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // the entry open in the card panel
  const [currency] = useCurrency()
  const [filter, setFilter] = useState('')
  const [bar, stuck] = useStuck<HTMLDivElement>()
  const phone = useMediaQuery('(max-width: 48em)')

  useEffect(() => {
    getJson('/api/wishlist')
      .then(setWanted)
      .catch(() => setWanted(null))
  }, [])

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

  const count = wanted?.reduce((sum, w) => sum + w.quantity, 0) ?? 0
  const value = wantedValue(wanted, currency)
  const open = wanted?.find((w) => w.id === editing)
  const some = !!wanted && wanted.length > 0
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? wanted?.filter((w) => [w.card.name, w.card.setName, w.card.setCode].some((t) => t.toLowerCase().includes(needle)))
    : wanted
  return (
    <>
      <div ref={bar} className={`${sticky} ${classes.bar}`} data-stuck={stuck || undefined}>
        {some && (
          <TextInput
            className={classes.filter}
            size="md" // as tall as the add box
            aria-label="Filter your wishlist"
            placeholder={phone ? 'Filter' : 'Filter your wishlist'}
            leftSection={<Icon name="filter_list" size={18} />}
            rightSection={filter && <CloseButton aria-label="Clear the filter" icon={<Icon name="close" size={18} />} onClick={() => setFilter('')} />}
            rightSectionPointerEvents="all"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
        )}
        <div className={classes.add}>
          <CardPicker
            label="Add a card"
            placeholder={phone ? 'Add a card' : 'Add a card: type "4 sol ring" to want four'}
            onPick={(scryfallId, quantity) => void run(() => sendJson('POST', '/api/wishlist', { scryfallId, quantity })).catch(() => {})}
          />
        </div>
        {some && (
          <Text size="sm" className={classes.totals}>
            <span data-testid="wishlist-count">
              {count} {count === 1 ? 'card' : 'cards'} wanted
            </span>
            {' · '}
            <strong data-testid="wishlist-value">≈ {formatPrice(value, currency)} to buy it all</strong>
          </Text>
        )}
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
            Search for a card above, or compare a deck with your collection and add what's missing. Only you see your wishlist.
          </EmptyState>
        )}
        {some && shown?.length === 0 && <Text c="dimmed">Nothing on your wishlist matches “{filter.trim()}”.</Text>}
        {some && shown && shown.length > 0 && (
          <ul className={classes.rows} aria-label="Wishlist">
            {shown.map((entry) => (
              <li key={entry.id} aria-label={entry.card.name}>
                <UnstyledButton className={classes.row} onClick={() => setEditing(entry.id)} aria-label={`Edit ${entry.card.name}`}>
                  <span className={classes.quantity} data-testid="quantity">
                    {entry.quantity}×
                  </span>
                  <img className={classes.thumb} src={entry.card.smallImage ?? entry.card.image ?? undefined} alt="" loading="lazy" data-preview />
                  <CardPreview src={entry.card.image} name={entry.card.name} />
                  <span className={classes.name}>
                    <span className={classes.cardName} data-preview>
                      {entry.card.name}
                    </span>
                  </span>
                  <Text span size="xs" c="dimmed" className={classes.printing} data-testid="printing" data-preview>
                    <span className={classes.long}>{printingLabel(entry.card)}</span>
                    <span className={classes.short}>
                      {entry.card.setCode.toUpperCase()} #{entry.card.collectorNumber}
                    </span>
                  </Text>
                  <span className={classes.mana} data-preview>
                    <ManaSymbols text={entry.card.manaCost} />
                  </span>
                  <span className={classes.price} data-preview>
                    {formatPrice(anyFinishPrice(entry.card, currency), currency)}
                  </span>
                  <Icon name="keyboard_arrow_down" size={18} className={classes.chevron} />
                </UnstyledButton>
              </li>
            ))}
          </ul>
        )}
        {some && (
          <Text size="xs" c="dimmed">
            Only you see your wishlist.
          </Text>
        )}

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
