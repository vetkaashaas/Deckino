import { ActionIcon, Button, Menu, Tooltip } from '@mantine/core'
import { useState, type ReactNode } from 'react'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { useDefaultCondition, useDefaultLanguage, type BinderSummary } from '../binders/binder'
import { copiesIn, defaultFinish, maxCopies, putEntry, toDeckCard, toRequest, type DeckSummary } from '../decks/deck'
import { Icon, type IconName } from '../components/Icon'
import { showToast } from '../components/toast'

const added = (message: string) => showToast({ message })
const failed = (message: string) => showToast({ message, error: true })

// One kind of place, as a submenu of its own (only when there's at least one to add to).
function Places<T extends { id: string; name: string }>({
  label,
  icon,
  places,
  onPick,
}: {
  label: string
  icon: IconName
  places: T[]
  onPick: (place: T) => void
}) {
  if (places.length === 0) return null
  return (
    <Menu.Sub>
      <Menu.Sub.Target>
        <Menu.Sub.Item leftSection={<Icon name={icon} size={16} />}>{label}</Menu.Sub.Item>
      </Menu.Sub.Target>
      {/* About seven rows, then it scrolls. */}
      <Menu.Sub.Dropdown w={240} mah={320} style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {places.map((p) => (
          <Menu.Item key={p.id} leftSection={<Icon name={icon} size={16} />} onClick={() => onPick(p)}>
            {p.name}
          </Menu.Item>
        ))}
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  )
}

// "Add to…" for one printing: the wishlist, a binder (one copy, in the condition and language set on the Account
// page) or a deck's mainboard. Binders and decks load when the menu opens. Signed out, there's nothing to add to, so nothing shows.
export function QuickAdd({ cardId, cardName, variant = 'icon' }: { cardId: string; cardName: string; variant?: 'icon' | 'button' }) {
  const { account } = useAuth()
  const [places, setPlaces] = useState<{ decks: DeckSummary[]; binders: BinderSummary[] } | null>()
  const [condition] = useDefaultCondition()
  const [language] = useDefaultLanguage()
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
      await sendJson('POST', `/api/binders/${binder.id}/cards`, { card: { scryfallId: cardId, finish, condition, language }, copies: 1 })
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
      <Menu.Dropdown>
        <Menu.Item leftSection={<Icon name="favorite" size={16} />} onClick={toWishlist}>
          Wishlist
        </Menu.Item>
        {places === undefined && <Menu.Item disabled>Loading your binders and decks…</Menu.Item>}
        {places && <Places label="Binders" icon="collections_bookmark" places={places.binders} onPick={toBinder} />}
        {places && <Places label="Decks" icon="style" places={places.decks} onPick={toDeck} />}
        {places === null && <Menu.Item disabled>Your binders and decks didn't load</Menu.Item>}
      </Menu.Dropdown>
    </Menu>
  )
}
