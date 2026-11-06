import { ActionIcon, Button, Menu, Tooltip } from '@mantine/core'
import { useState, type ReactNode } from 'react'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import type { BinderSummary } from '../binders/binder'
import { copiesIn, defaultFinish, maxCopies, putEntry, toDeckCard, toRequest, type DeckSummary } from '../decks/deck'
import { Icon } from '../components/Icon'
import { showToast } from '../components/toast'

const added = (message: string) => showToast({ message })
const failed = (message: string) => showToast({ message, error: true })

// "Add to…" for one printing: a deck's mainboard, a binder (as one Near Mint English copy) or the wishlist. Decks
// and binders load when the menu opens. Signed out, there's nothing to add to, so nothing shows.
export function QuickAdd({ cardId, cardName, variant = 'icon' }: { cardId: string; cardName: string; variant?: 'icon' | 'button' }) {
  const { account } = useAuth()
  const [places, setPlaces] = useState<{ decks: DeckSummary[]; binders: BinderSummary[] } | null>()
  if (!account) return null

  // Every time the menu opens, so decks and binders made since show up; the last list stays up while it loads.
  function load() {
    Promise.all([getJson('/api/decks'), getJson('/api/binders')])
      .then(([decks, binders]) => setPlaces({ decks, binders }))
      .catch(() => setPlaces((p) => p ?? null))
  }

  async function toDeck(deck: DeckSummary) {
    try {
      const [detail, card] = await Promise.all([getJson(`/api/decks/${deck.id}`), getJson(`/api/cards/${cardId}`)])
      const deckCard = toDeckCard(card)
      const entry = { scryfallId: card.id, quantity: 1, finish: defaultFinish(deckCard), card: deckCard }
      if (copiesIn(detail, 'mainboard', entry) >= maxCopies(detail.format, 'mainboard', deckCard)) {
        added(`${cardName} is already in ${deck.name}.`)
        return
      }
      await sendJson('PUT', `/api/decks/${deck.id}`, toRequest({ ...detail, mainboard: putEntry(detail.mainboard, entry) }))
      added(`Added ${cardName} to ${deck.name}.`)
    } catch {
      failed(`${cardName} wasn't added to ${deck.name}. Try again.`)
    }
  }

  async function toBinder(binder: BinderSummary) {
    try {
      const card = await getJson(`/api/cards/${cardId}`)
      const finish = defaultFinish(toDeckCard(card))
      await sendJson('POST', `/api/binders/${binder.id}/cards`, { card: { scryfallId: cardId, finish, condition: 'NM', language: 'en' }, copies: 1 })
      added(`Added ${cardName} to ${binder.name}.`)
    } catch {
      failed(`${cardName} wasn't added to ${binder.name}. Try again.`)
    }
  }

  async function toWishlist() {
    try {
      await sendJson('POST', '/api/wishlist', { scryfallId: cardId, quantity: 1 })
      added(`Added ${cardName} to your wishlist.`)
    } catch {
      failed(`${cardName} wasn't added to your wishlist. Try again.`)
    }
  }

  const target: ReactNode =
    variant === 'icon' ? (
      <Tooltip label="Add to…" withArrow>
        <ActionIcon variant="filled" color="dark.7" size="lg" radius="xl" aria-label={`Add ${cardName} to…`} data-quick-add>
          <Icon name="add" size={18} />
        </ActionIcon>
      </Tooltip>
    ) : (
      <Button variant="gradient" leftSection={<Icon name="add" size={18} />}>
        Add to…
      </Button>
    )

  return (
    <Menu position="bottom-end" withinPortal onOpen={load} width={240}>
      <Menu.Target>{target}</Menu.Target>
      <Menu.Dropdown mah={420} style={{ overflowY: 'auto' }}>
        <Menu.Item leftSection={<Icon name="favorite" size={16} />} onClick={toWishlist}>
          Wishlist
        </Menu.Item>
        <Menu.Label>Decks</Menu.Label>
        {places === undefined && <Menu.Item disabled>Loading…</Menu.Item>}
        {places?.decks.length === 0 && <Menu.Item disabled>No decks yet</Menu.Item>}
        {places?.decks.map((d) => (
          <Menu.Item key={d.id} leftSection={<Icon name="style" size={16} />} onClick={() => toDeck(d)}>
            {d.name}
          </Menu.Item>
        ))}
        <Menu.Label>Binders</Menu.Label>
        {places === undefined && <Menu.Item disabled>Loading…</Menu.Item>}
        {places?.binders.length === 0 && <Menu.Item disabled>No binders yet</Menu.Item>}
        {places?.binders.map((b) => (
          <Menu.Item key={b.id} leftSection={<Icon name="collections_bookmark" size={16} />} onClick={() => toBinder(b)}>
            {b.name}
          </Menu.Item>
        ))}
        {places === null && <Menu.Item disabled>Your decks and binders didn't load</Menu.Item>}
      </Menu.Dropdown>
    </Menu>
  )
}
