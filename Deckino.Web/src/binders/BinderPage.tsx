import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Chip,
  CloseButton,
  Container,
  Group,
  Menu,
  Modal,
  Skeleton,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import type { CardDetail } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { CardPanel, type PanelValues } from '../components/CardPanel'
import { EditableTitle } from '../components/EditableTitle'
import { ArtHeader } from '../components/ArtHeader'
import { EmptyState } from '../components/EmptyState'
import { formatPrice, useCurrency } from '../components/currency'
import { showToast } from '../components/toast'
import { entryPrice, toDeckCard, type Finish } from '../decks/deck'
import {
  conditions,
  groupCopies,
  languages,
  useDefaultCondition,
  useDefaultLanguage,
  type BinderDetail,
  type BinderSummary,
  type CardGroup,
} from './binder'
import classes from './BinderPage.module.css'
import { CopyCells } from './CopyCells'
import { Icon } from '../components/Icon'

const failure = (e: unknown) => (e instanceof ApiError ? e.message : "Deckino didn't respond. Try again.")

// What the API takes for a copy, from the panel's values.
const toRequest = (v: PanelValues) => ({
  scryfallId: v.card.id,
  finish: v.finish!,
  condition: v.condition!,
  language: v.language!,
  notes: v.notes ?? '',
})

// What's being changed in the card panel: a row's copies, or a card about to go in.
type Editing = { kind: 'edit'; group: CardGroup } | { kind: 'add'; values: PanelValues } | null

// A row: its copies (all alike), which opens the card panel.
function CopyRow({ group, selected, onSelect, onOpen }: { group: CardGroup; selected: boolean; onSelect: (selected: boolean) => void; onOpen: () => void }) {
  const copy = group.copies[0]
  return (
    <li className={classes.row} aria-label={copy.card.name}>
      <Checkbox aria-label={`Select ${copy.card.name}`} checked={selected} onChange={(e) => onSelect(e.currentTarget.checked)} />
      <UnstyledButton className={classes.open} onClick={onOpen} aria-label={`Edit ${copy.card.name}`}>
        <CopyCells count={group.copies.length} {...copy} unchecked={!copy.printingConfirmed} open />
      </UnstyledButton>
    </li>
  )
}

function BinderEditor({ initial }: { initial: BinderDetail }) {
  const navigate = useNavigate()
  const [binder, setBinder] = useState(initial)
  const [others, setOthers] = useState<BinderSummary[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Editing>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, copiedNote] = useDisclosure()
  const [currency] = useCurrency()

  useEffect(() => {
    getJson('/api/binders')
      .then((all) => setOthers(all.filter((b) => b.id !== initial.id)))
      .catch(() => setOthers([]))
  }, [initial.id])

  const groups = groupCopies(binder.cards)
  const url = `/api/binders/${binder.id}` as const

  // Every change saves straight away and returns the binder as it now is. One at a time: each waits for the one
  // before (quick adds can come faster than the API answers), so responses can't arrive out of order and show an
  // older binder.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.current.then(task)
    queue.current = next.catch(() => {}) // a failed change doesn't stop the ones after it
    return next
  }
  // A change from the page: its failure shows above the cards. (The panel shows its own, so it enqueues directly.)
  function run(action: () => Promise<BinderDetail>): Promise<boolean> {
    return enqueue(async () => {
      setBusy(true)
      setError(null)
      try {
        setBinder(await action())
        return true
      } catch (e) {
        setError(failure(e))
        return false
      } finally {
        setBusy(false)
      }
    })
  }

  // Copies moved out, then back on Undo (they keep their ids). This binder reloads afterwards.
  async function move(ids: string[], to: string, name: string) {
    if (!(await run(() => sendJson('POST', `${url}/cards/move`, { cardIds: ids, toBinderId: to })))) return false
    const target = others.find((o) => o.id === to)?.name ?? 'the other binder'
    showToast({
      message: `Moved ${name} to ${target}`,
      undo: () =>
        void run(async () => {
          await sendJson('POST', `/api/binders/${to}/cards/move`, { cardIds: ids, toBinderId: binder.id })
          return getJson(`/api/binders/${binder.id}`)
        }),
    })
    return true
  }

  // Removed copies come back as they were on Undo (with new ids). A row's copies are alike, so each row goes back as
  // one line, split at the API's 100 copies a line.
  async function remove(rows: CardGroup[]) {
    const ids = rows.flatMap((g) => g.copies.map((c) => c.id))
    if (!(await run(() => sendJson('POST', `${url}/cards/remove`, { cardIds: ids })))) return false
    const cards = rows.flatMap(({ copies }) => {
      const { scryfallId, finish, condition, language, notes, printingConfirmed } = copies[0]
      const card = { scryfallId, finish, condition, language, notes, printingConfirmed }
      return Array.from({ length: Math.ceil(copies.length / 100) }, (_, i) => ({ card, copies: Math.min(100, copies.length - i * 100) }))
    })
    showToast({
      message: rows.length === 1 ? `Removed ${rows[0].copies[0].card.name}` : `Removed ${ids.length} cards`,
      undo: () => void run(async () => (await sendJson('POST', `${url}/cards/batch`, { cards })).binder),
    })
    return true
  }

  // A row's copies changed together: fewer copies drop the last ones, more add alike ones. Saving marks the
  // printing checked (the API does for any edit), so an unchanged save of a scanned card confirms it.
  async function saveGroup(group: CardGroup, values: PanelValues) {
    const copies = group.copies
    const first = copies[0]
    const card = toRequest(values)
    const same =
      first.printingConfirmed &&
      card.scryfallId === first.scryfallId &&
      card.finish === first.finish &&
      card.condition === first.condition &&
      card.language === first.language &&
      card.notes === (first.notes ?? '')
    await enqueue(async () => {
      let latest: BinderDetail | undefined
      try {
        const drop = copies.slice(values.copies)
        if (drop.length > 0) latest = await sendJson('POST', `${url}/cards/remove`, { cardIds: drop.map((c) => c.id) })
        if (!same) for (const c of copies.slice(0, values.copies)) latest = await sendJson('PUT', `${url}/cards/${c.id}`, card)
        if (values.copies > copies.length) latest = await sendJson('POST', `${url}/cards`, { card, copies: values.copies - copies.length })
      } finally {
        if (latest) setBinder(latest) // what did save shows, even when a later request failed
      }
    })
    setEditing(null)
  }

  // How quick-added cards go in: the condition and language set on the Account page (as the app's Preferences),
  // and Foil and "Pick printing & notes" kept for this visit, so a stack of cards from the same box goes in fast.
  const [condition] = useDefaultCondition()
  const [language] = useDefaultLanguage()
  const [addAs, setAddAs] = useState({ foil: false, detailed: false })
  async function quickAdd(scryfallId: string, copies: number) {
    let card: CardDetail
    try {
      card = await getJson(`/api/cards/${scryfallId}`)
    } catch {
      setError("That card didn't load. Try again.")
      return
    }
    const finishes = card.finishes
    // Foil asked for: the printing's foil (or etched) finish; otherwise its normal one, if it has one.
    const finish: Finish = addAs.foil
      ? (finishes.find((f) => f !== 'nonfoil') ?? finishes[0])
      : finishes.includes('nonfoil')
        ? 'nonfoil'
        : finishes[0]
    const values: PanelValues = { card: toDeckCard(card), finish, condition, language, notes: '', copies }
    if (addAs.detailed) {
      setEditing({ kind: 'add', values })
      return
    }
    if (await run(() => sendJson('POST', `${url}/cards`, { card: toRequest(values), copies }))) {
      const added = `Added ${copies > 1 ? `${copies}× ` : ''}${card.name}`
      // Foil asked for, but this printing isn't made in foil: say what went in instead.
      showToast({ message: addAs.foil && finish === 'nonfoil' ? `${added} as Normal: this printing isn't made in foil.` : `${added}.` })
    }
  }

  const selectedGroups = groups.filter((g) => selected.has(g.key))
  const selectedIds = selectedGroups.flatMap((g) => g.copies.map((c) => c.id))
  const unchecked = binder.cards.filter((c) => !c.printingConfirmed).length
  const cover = binder.cards[0]?.card
  const count = binder.cards.length
  const value = binder.cards.reduce((sum, c) => sum + (entryPrice(c, currency) ?? 0), 0)
  const publicPath = `/binder/${binder.id}`
  // The row being edited as it is now (a save or Undo may have changed the binder); gone once it's removed.
  const editedGroup = editing?.kind === 'edit' ? groups.find((g) => g.key === editing.group.key) : undefined
  const targets = others.map((o) => ({ value: o.id, label: o.name }))

  return (
    <>
      <ArtHeader art={cover?.artCrop ?? cover?.image}>
        <div className={classes.hero}>
          <div className={classes.heroText}>
            <Anchor component={Link} to="/collection" size="sm" c="dark.1">
              Collection
            </Anchor>
            <EditableTitle
              name={binder.name}
              label="Binder name"
              renameLabel="Rename binder"
              onRename={(name) => run(() => sendJson('PUT', url, { name }))}
            />
            <Group gap="md" mt="sm" className={classes.facts}>
              {binder.isPublic && (
                <Badge variant="light" size="lg">
                  Public
                </Badge>
              )}
              {binder.isSelling && (
                <Badge variant="gradient" size="lg">
                  Selling
                </Badge>
              )}
              <span data-testid="binder-count">
                {count} {count === 1 ? 'card' : 'cards'}
              </span>
              <span data-testid="binder-value">≈ {formatPrice(value, currency)}</span>
            </Group>
          </div>
          <div className={classes.heroActions}>
            <Group gap="sm" className={classes.switches}>
              <Switch
                label="Public"
                description="Anyone with the link can see it"
                checked={binder.isPublic}
                disabled={busy}
                onChange={(e) => {
                  const isPublic = e.currentTarget.checked
                  run(() => sendJson('PUT', url, { isPublic }))
                }}
              />
              <Switch
                label="Selling"
                description="Marks the cards as for sale"
                checked={binder.isSelling}
                disabled={busy}
                onChange={(e) => {
                  const isSelling = e.currentTarget.checked
                  run(() => sendJson('PUT', url, { isSelling }))
                }}
              />
            </Group>
            <Group gap="xs" wrap="nowrap">
              {binder.isPublic && (
                <>
                  <Button
                    variant="default"
                    leftSection={<Icon name="content_copy" size={16} />}
                    onClick={() => {
                      navigator.clipboard?.writeText(new URL(publicPath, window.location.origin).href).catch(() => {})
                      copiedNote.open()
                      setTimeout(copiedNote.close, 2000)
                    }}
                  >
                    {copied ? 'Link copied' : 'Copy link'}
                  </Button>
                  <Button component={Link} to={publicPath} variant="subtle" leftSection={<Icon name="open_in_new" size={16} />}>
                    Public page
                  </Button>
                </>
              )}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="default" size="lg" aria-label="Binder actions">
                    <Icon name="more_horiz" size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item component="a" href={`${url}/export`} download leftSection={<Icon name="download" size={16} />}>
                    Export CSV
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item color="danger" leftSection={<Icon name="delete" size={16} />} onClick={() => setDeleting(true)}>
                    Delete binder
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </div>
        </div>
      </ArtHeader>

      <Container size="lg">
        {error && (
          <Alert color="danger" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Quick add: the card goes straight in with these details; opening its row changes it afterwards. */}
        <div className={classes.addBar} role="group" aria-label="Add cards">
          <div className={classes.search}>
            <CardPicker label="Add a card" placeholder={'Add a card: type "4 sol ring" for four copies'} onPick={quickAdd} />
          </div>
          <Group gap="xs" wrap="nowrap" className={classes.addAs}>
            {/* What they go in as, and where that's set. */}
            <Anchor component={Link} to="/account" size="sm" c="dimmed" title="Change on the Account page">
              {conditions.find((c) => c.value === condition)?.label} · {languages.find((l) => l.value === language)?.label}
            </Anchor>
            <Chip checked={addAs.foil} onChange={(foil) => setAddAs((a) => ({ ...a, foil }))} size="md">
              Foil
            </Chip>
            <Chip checked={addAs.detailed} onChange={(detailed) => setAddAs((a) => ({ ...a, detailed }))} size="md">
              Pick printing & notes
            </Chip>
          </Group>
        </div>

        {unchecked > 0 && (
          <Alert color="warning" mb="lg" title={`${unchecked} scanned ${unchecked === 1 ? 'card might be' : 'cards might be'} a different printing`}>
            The app matched the artwork, which several sets can share. Open each card marked Check printing, compare
            the set symbol and save the right printing.
          </Alert>
        )}

        {groups.length === 0 ? (
          <EmptyState title="This binder is empty">
            Search for a card above to add it, with its printing, finish, condition and language.
          </EmptyState>
        ) : (
          <ul className={classes.rows} aria-label="Cards" data-selecting={selectedIds.length > 0 || undefined}>
            {groups.map((group) => (
              <CopyRow
                key={group.key}
                group={group}
                selected={selected.has(group.key)}
                onSelect={(on) =>
                  setSelected((s) => {
                    const next = new Set(s)
                    if (on) next.add(group.key)
                    else next.delete(group.key)
                    return next
                  })
                }
                onOpen={() => setEditing({ kind: 'edit', group })}
              />
            ))}
          </ul>
        )}
      </Container>

      {/* The app's selection bar, at the bottom of the screen (over the phone's tab bar): Move N, Remove N. */}
      {selectedIds.length > 0 && (
        <div className={classes.selection} role="region" aria-label="Selection" data-selection-bar>
          <Text fw={600} className={classes.selectionCount}>
            {selectedIds.length} {selectedIds.length === 1 ? 'card' : 'cards'} selected
          </Text>
          <Menu position="top-end" withinPortal>
            <Menu.Target>
              <Button
                variant="default"
                leftSection={<Icon name="drive_file_move" size={18} />}
                disabled={others.length === 0 || busy}
                title={others.length === 0 ? 'Make another binder to move cards to' : undefined}
              >
                Move {selectedIds.length}
              </Button>
            </Menu.Target>
            <Menu.Dropdown mah={320} style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
              <Menu.Label>Move to</Menu.Label>
              {others.map((o) => (
                <Menu.Item
                  key={o.id}
                  leftSection={<Icon name="collections_bookmark" size={16} />}
                  onClick={async () => {
                    const n = selectedIds.length
                    if (await move(selectedIds, o.id, `${n} ${n === 1 ? 'card' : 'cards'}`)) setSelected(new Set())
                  }}
                >
                  {o.name}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button
            variant="default"
            leftSection={<Icon name="delete" size={18} />}
            disabled={busy}
            onClick={async () => {
              if (await remove(selectedGroups)) setSelected(new Set())
            }}
          >
            Remove {selectedIds.length}
          </Button>
          <CloseButton aria-label="Clear the selection" icon={<Icon name="close" size={20} />} onClick={() => setSelected(new Set())} />
        </div>
      )}

      {editedGroup && (
        <CardPanel
          key={editedGroup.key}
          initial={{
            card: editedGroup.copies[0].card,
            copies: editedGroup.copies.length,
            finish: editedGroup.copies[0].finish,
            condition: editedGroup.copies[0].condition,
            language: editedGroup.copies[0].language,
            notes: editedGroup.copies[0].notes ?? '',
          }}
          unchecked={!editedGroup.copies[0].printingConfirmed}
          maxCopies={() => editedGroup.copies.length + 100} // never fewer than it has; the API adds 100 at a time
          removeLabel="Remove from binder"
          moveTo={targets}
          onSave={(values) => saveGroup(editedGroup, values)}
          onMove={async (to) => {
            const ids = editedGroup.copies.map((c) => c.id)
            if (await move(ids, to, editedGroup.copies[0].card.name)) setEditing(null)
          }}
          onRemove={() => {
            setEditing(null)
            void remove([editedGroup])
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'add' && (
        <CardPanel
          initial={editing.values}
          saveLabel="Add to binder"
          maxCopies={() => 100}
          onSave={async (values) => {
            await enqueue(async () => setBinder(await sendJson('POST', `${url}/cards`, { card: toRequest(values), copies: values.copies })))
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Deleting a binder can't be undone, so it asks first. */}
      <Modal opened={deleting} onClose={() => setDeleting(false)} title={`Delete ${binder.name}?`} centered>
        <Stack gap="md">
          <Text>This permanently deletes the binder and the {count === 1 ? 'card' : `${count} cards`} in it. It can't be undone.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleting(false)}>
              Keep binder
            </Button>
            <Button
              color="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await sendJson('DELETE', url)
                  navigate('/collection', { replace: true })
                } catch {
                  setDeleting(false)
                  setError("The binder wasn't deleted. Try again.")
                  setBusy(false)
                }
              }}
            >
              Delete binder
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}

export default function BinderPage() {
  const { id } = useParams()
  const { account } = useAuth()
  const location = useLocation()
  // undefined while loading; null when there's no such binder of this user's; 'signed-out' on a 401; 'failed' otherwise.
  const [binder, setBinder] = useState<BinderDetail | null | 'signed-out' | 'failed'>()

  useEffect(() => {
    if (!account) return
    let current = true
    getJson(`/api/binders/${id}`)
      .then((b) => current && setBinder(b))
      .catch((e) => {
        if (!current) return
        const status = e instanceof ApiError ? e.status : 0
        setBinder(status === 404 ? null : status === 401 ? 'signed-out' : 'failed')
      })
    return () => {
      current = false
    }
  }, [id, account])

  if (account === undefined) return null
  if (account === null || binder === 'signed-out') {
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />
  }
  if (binder === undefined) {
    return (
      <Container size="lg" py="xl" aria-busy="true">
        <Skeleton height={48} width="50%" mb="xl" />
        <Skeleton height={300} />
      </Container>
    )
  }
  if (binder === 'failed') {
    return (
      <Container size="lg" py="xl">
        <Alert color="danger" title="Your binder didn't load" role="alert">
          Deckino didn't respond. Reload the page to try again.
        </Alert>
      </Container>
    )
  }
  if (binder === null) {
    return (
      <Container size="lg" py="xl">
        <Alert color="danger" title="Binder not found" role="alert">
          No binder of yours has this address. <Anchor component={Link} to="/collection">See your collection</Anchor>.
        </Alert>
      </Container>
    )
  }
  return <BinderEditor key={binder.id} initial={binder} />
}
