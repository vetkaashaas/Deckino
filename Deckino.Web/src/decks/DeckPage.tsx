import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  CopyButton,
  Group,
  Menu,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useBlocker, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { CardPicker } from '../cards/CardPicker'
import { CardPanel, type PanelValues } from '../components/CardPanel'
import { ArtHeader } from '../components/ArtHeader'
import { formatPrice, useCurrency } from '../components/currency'
import { showToast } from '../components/toast'
import { EditableTitle } from '../components/EditableTitle'
import type * as Api from '../generated'
import { useRemembered } from '../components/useRemembered'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols } from '../components/ManaSymbols'
import {
  copiesIn,
  countCards,
  deckLook,
  defaultFinish,
  entryKey,
  entryPrice,
  formats,
  isSingleton,
  maxCopies,
  putEntry,
  sectionLabel,
  targetSize,
  toDeckCard,
  toRequest,
  type DeckCard,
  type DeckDetail,
  type DeckEntry,
  type SectionName,
} from './deck'
import { DeckHero, DeckSection, LegalityAlert } from './DeckParts'
import { DeckGallery, GallerySizeControl, useGallerySize } from './DeckGallery'
import { DeckStacks, type StackActions } from './DeckStacks'
import { DeckStatsLine } from './DeckStats'
import { sticky, useStuck } from '../components/sticky'
import classes from './DeckPage.module.css'
import { Icon } from '../components/Icon'

export { LegalityAlert } from './DeckParts'

type Draft = Omit<DeckDetail, 'id' | 'isPublic' | 'createdAt' | 'updatedAt'>
type View = 'list' | 'gallery' | 'stacks'
type SaveState = 'saved' | 'pending' | 'saving' | 'failed'

const fetchCard = async (id: string) => toDeckCard(await getJson(`/api/cards/${id}`))
// A card that can lead a deck, or join a commander that chooses a Background.
const canLead = (card: DeckCard) => card.canBeCommander || card.typeLine?.includes('Background') === true

// List, gallery or stacks, remembered in this browser like the currency.
const useView = () => useRemembered<View>('deckino.deckView', ['list', 'gallery', 'stacks'], 'list')

// The draft's format warnings from the API, rechecked shortly after each change. The last answer stays up while
// the next one loads; a failed check shows nothing rather than a wrong verdict.
function Legality({ draft }: { draft: Draft }) {
  const { format, cards } = toRequest(draft)
  const key = JSON.stringify({ format, cards })
  const [result, setResult] = useState<{ format: string; warnings: string[] } | null>(null)

  useEffect(() => {
    let current = true
    const wait = setTimeout(() => {
      const body = JSON.parse(key) as { format: typeof format; cards: typeof cards }
      sendJson('POST', '/api/decks/legality', body)
        .then((warnings) => current && setResult({ format: body.format, warnings }))
        .catch(() => current && setResult(null))
    }, 250)
    return () => {
      current = false
      clearTimeout(wait)
    }
  }, [key])

  if (format === 'casual' || !result || result.format !== format) return null
  return <LegalityAlert format={result.format} warnings={result.warnings} />
}

type DeckComparison = Api.DeckComparison

// How the saved deck compares with the cards in the user's binders, and its missing cards onto the wishlist.
function CompareWithCollection({ deckId }: { deckId: string }) {
  const [open, dialog] = useDisclosure()
  const [result, setResult] = useState<DeckComparison | null>()
  const [added, setAdded] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function show() {
    dialog.open()
    setResult(undefined)
    setAdded(null)
    setError(null)
    getJson(`/api/decks/${deckId}/collection`)
      .then(setResult)
      .catch(() => setResult(null))
  }

  async function addMissing() {
    setAdding(true)
    setError(null)
    try {
      setAdded((await sendJson('POST', `/api/decks/${deckId}/collection/wishlist`)).added)
    } catch {
      setError("The wishlist wasn't changed. Try again.")
    } finally {
      setAdding(false)
    }
  }

  const share = result && result.owned + result.missing > 0 ? (result.owned / (result.owned + result.missing)) * 100 : 0
  return (
    <>
      <Button variant="default" size="xs" leftSection={<Icon name="style" size={16} />} onClick={show}>
        Compare with my collection
      </Button>
      <Modal opened={open} onClose={dialog.close} title="Compared with your binders" centered size="lg">
        <Stack gap="md">
          {result === undefined && <Skeleton height={160} aria-busy="true" />}
          {result === null && <Alert color="danger" role="alert">The comparison didn't load. Try again.</Alert>}
          {result && (
            <>
              <div data-testid="collection-totals" className={classes.totals}>
                <Group gap="lg">
                  <Text fw={700} c="success">
                    Owned {result.owned}
                  </Text>
                  <Text fw={700} c={result.missing ? 'warning' : 'dimmed'}>
                    Missing {result.missing}
                  </Text>
                </Group>
                <span className={classes.ownedTrack} aria-hidden="true">
                  <span className={classes.ownedBar} style={{ width: `${share}%` }} />
                </span>
              </div>
              <ul className={classes.comparison} aria-label="Cards compared">
                {result.cards.map((c) => (
                  <li key={c.oracleId} className={classes.comparisonRow} aria-label={c.name}>
                    <span className={classes.cardName}>{c.name}</span>
                    <Text size="sm" c="dimmed" className={classes.comparisonCounts}>
                      {c.owned} of {c.needed} owned
                    </Text>
                    {c.missing > 0 ? (
                      <Badge color="warning" variant="light">
                        {c.missing} missing
                      </Badge>
                    ) : (
                      <Badge color="success" variant="light">
                        Owned
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
              {error && <Alert color="danger" role="alert">{error}</Alert>}
              {added !== null && (
                <Alert color="success" role="status">
                  {added === 0
                    ? 'Your wishlist already has every missing card.'
                    : `Added ${added} ${added === 1 ? 'card' : 'cards'} to your wishlist.`}{' '}
                  <Anchor component={Link} to="/wishlist">
                    See your wishlist
                  </Anchor>
                </Alert>
              )}
              <Group justify="flex-end">
                <Button variant="gradient" disabled={result.missing === 0} loading={adding} onClick={addMissing}>
                  Add missing to wishlist
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
    </>
  )
}

function DeleteDeck({ deck, opened, onClose, onDeleted }: { deck: DeckDetail; opened: boolean; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setDeleting(true)
    setError(null)
    try {
      await sendJson('DELETE', `/api/decks/${deck.id}`)
      onDeleted()
    } catch {
      setError("The deck wasn't deleted. Try again.")
      setDeleting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Delete ${deck.name}?`} centered>
      <Stack gap="md">
        <Text>This permanently deletes the deck. It can't be undone.</Text>
        {error && <Alert color="danger" role="alert">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Keep deck
          </Button>
          <Button color="danger" loading={deleting} onClick={remove}>
            Delete deck
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <span role="status" className={classes.saveStatus} data-state={state} data-testid="save-status">
      {state === 'saved' && (
        <>
          <Icon name="cloud_done" size={16} /> Saved
        </>
      )}
      {(state === 'pending' || state === 'saving') && (
        <>
          <Icon name="progress_activity" size={16} className={classes.spin} /> Saving…
        </>
      )}
      {state === 'failed' && (
        <>
          Not saved.{' '}
          <Anchor component="button" size="sm" onClick={onRetry}>
            Try again
          </Anchor>
        </>
      )}
    </span>
  )
}

function DeckEditor({ saved, onSaved }: { saved: DeckDetail; onSaved: (deck: DeckDetail) => void }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<Draft>(saved)
  const [currency] = useCurrency()
  const [view, setView] = useView()
  const [gallerySize, setGallerySize] = useGallerySize()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState(saved.isPublic)
  const [publishing, setPublishing] = useState(false)
  const [deleting, deleteDialog] = useDisclosure()
  const [target, setTarget] = useState<SectionName>()
  const [editing, setEditing] = useState<{ section: SectionName; key: string } | null>(null) // the card open in the panel
  const leaving = useRef(false) // set once the deck is deleted, so the redirect isn't blocked

  // Autosave: a change is saved shortly after the last edit. sentJson is what the API has (or is being sent).
  const json = JSON.stringify(toRequest(draft))
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(toRequest(saved)))
  const [saving, setSaving] = useState(false)
  // The draft whose save failed: it waits for "Try again", and any new edit tries again by itself.
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const failed = failedFor === json
  const dirty = json !== savedJson
  const state: SaveState = saving ? 'saving' : failed && dirty ? 'failed' : dirty ? 'pending' : 'saved'

  // One save at a time: a save asked for while another runs (leaving the page mid-autosave) waits for it, so the
  // API always gets the drafts in order.
  const inFlight = useRef<Promise<boolean>>(Promise.resolve(true))
  function save(body: string): Promise<boolean> {
    const next = inFlight.current.then(() => send(body))
    inFlight.current = next
    return next
  }

  async function send(body: string): Promise<boolean> {
    setSaving(true)
    setFailedFor(null)
    try {
      const deck = await sendJson('PUT', `/api/decks/${saved.id}`, JSON.parse(body))
      setSavedJson(body)
      onSaved(deck)
      return true
    } catch (e) {
      setFailedFor(body)
      if (!(e instanceof ApiError)) setError("Deckino didn't respond, so your latest changes aren't saved yet.")
      else if (e.status === 401) setError('You were logged out. Log in again in another tab, and your changes will save.')
      else setError(e.fieldErrors.cards ?? e.fieldErrors.name ?? e.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!dirty || saving || failed) return
    const wait = setTimeout(() => save(json), 700)
    return () => clearTimeout(wait)
  }, [json, dirty, saving, failed]) // eslint-disable-line react-hooks/exhaustive-deps -- save only reads what's listed

  // Leaving while a change is waiting: save it first, and only ask when that fails.
  const blocker = useBlocker(() => dirty && !leaving.current)
  const [leaveFailed, setLeaveFailed] = useState(false)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let current = true
    save(json).then((ok) => {
      if (!current) return
      if (ok) blocker.proceed()
      else setLeaveFailed(true)
    })
    return () => {
      current = false
    }
  }, [blocker.state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per blocked navigation

  const stay = () => {
    setLeaveFailed(false)
    blocker.reset?.()
  }

  // Closing the tab or reloading before the save: the browser asks.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Public or private saves at once.
  async function setVisibility(value: boolean) {
    setPublishing(true)
    setError(null)
    try {
      setIsPublic((await sendJson('PUT', `/api/decks/${saved.id}/visibility`, { isPublic: value })).isPublic)
    } catch {
      setError(value ? "The deck wasn't made public. Try again." : "The deck wasn't made private. Try again.")
    } finally {
      setPublishing(false)
    }
  }

  const format = draft.format
  const sections: SectionName[] =
    format === 'commander' || draft.commander.length > 0 ? ['commander', 'mainboard', 'sideboard'] : ['mainboard', 'sideboard']
  // A Commander deck without a commander starts by choosing one.
  const needsCommander = format === 'commander' && draft.commander.length === 0
  const addTo: SectionName = target && sections.includes(target) ? target : needsCommander ? 'commander' : 'mainboard'

  const editSection = (section: SectionName, change: (entries: DeckEntry[]) => DeckEntry[]) =>
    setDraft((d) => ({ ...d, [section]: change(d[section]) }))
  const without = (entries: DeckEntry[], entry: DeckEntry) => entries.filter((e) => entryKey(e) !== entryKey(entry))

  // Card data comes from the API; a failed lookup leaves the deck as it was.
  async function withCard(id: string, apply: (card: DeckCard) => void) {
    try {
      apply(await fetchCard(id))
    } catch {
      setError("That card didn't load. Try again.")
    }
  }

  const moveTargets = (section: SectionName, entry: DeckEntry) =>
    sections
      .filter((s) => s !== section)
      // Not the same card twice: a second copy of the commander would only merge into it.
      .filter(
        (s) =>
          s !== 'commander' ||
          (canLead(entry.card) && draft.commander.length < 2 && !draft.commander.some((c) => c.card.oracleId === entry.card.oracleId)),
      )
      .map((to) => ({ to, label: to === 'commander' ? 'Set as commander' : `Move to ${sectionLabel(to, format).toLowerCase()}` }))

  // How many more copies of an entry a section takes, as the format allows.
  function room(d: Draft, section: SectionName, entry: DeckEntry) {
    return maxCopies(d.format, section, entry.card) - copiesIn(d, section, entry)
  }

  // The card panel's save: its printing, finish and copies, and the part of the deck it's in. Moving to Commander
  // takes one copy; any others stay where they were.
  function saveEntry(section: SectionName, key: string, values: PanelValues) {
    const to = values.section as SectionName
    setDraft((d) => {
      const current = d[section].find((e) => entryKey(e) === key)
      if (!current) return d
      const moved = to === section ? current.quantity : Math.min(current.quantity, values.copies)
      const left = current.quantity - moved
      const next = {
        ...d,
        [section]: left > 0 ? d[section].map((e) => (e === current ? { ...e, quantity: left } : e)) : without(d[section], current),
      }
      next[to] = putEntry(next[to], { scryfallId: values.card.id, quantity: values.copies, finish: values.finish!, card: values.card })
      return next
    })
  }

  // Out of the deck, and back in with Undo.
  function removeEntry(section: SectionName, entry: DeckEntry) {
    editSection(section, (entries) => without(entries, entry))
    showToast({ message: `Removed ${entry.card.name}`, undo: () => editSection(section, (entries) => putEntry(entries, entry)) })
  }

  const setQuantity = (section: SectionName, entry: DeckEntry, quantity: number) =>
    editSection(section, (entries) => entries.map((e) => (entryKey(e) === entryKey(entry) ? { ...e, quantity } : e)))

  // Adds copies, up to what the format allows there; at the limit it says so instead. The draft as it is once the
  // card has loaded (latest), not as it was when the search was picked.
  const latest = useRef(draft)
  useEffect(() => {
    latest.current = draft
  })
  const add = (id: string, quantity: number) =>
    withCard(id, (card) => {
      const entry = { scryfallId: card.id, quantity, finish: defaultFinish(card), card }
      if (room(latest.current, addTo, entry) <= 0) {
        const max = maxCopies(latest.current.format, addTo, card)
        setNotice(
          max === 1 && addTo !== 'commander'
            ? `${card.name} is already in the deck: this format allows one copy.`
            : `${card.name} is already in the ${sectionLabel(addTo, format).toLowerCase()}.`,
        )
        return
      }
      setNotice(null)
      setDraft((d) => {
        const left = room(d, addTo, entry)
        return left > 0 ? { ...d, [addTo]: putEntry(d[addTo], { ...entry, quantity: Math.min(quantity, left) }) } : d
      })
      if (addTo === 'commander') setTarget(undefined)
    })

  const open = (section: SectionName) => (entry: DeckEntry) => setEditing({ section, key: entryKey(entry) })
  const stackActions = (section: SectionName): StackActions => ({
    canAdd: (entry) => entry.quantity < maxCopies(format, section, entry.card),
    onQuantity: (entry, quantity) => setQuantity(section, entry, quantity),
    onEdit: open(section),
  })
  // The card open in the panel, as it is now; gone once it's removed or saved under another printing.
  const edited = editing && draft[editing.section].find((e) => entryKey(e) === editing.key)

  const look = deckLook(draft)
  const all = [...draft.commander, ...draft.mainboard, ...draft.sideboard]
  const value = all.reduce((sum, e) => sum + (entryPrice(e, currency) ?? 0) * e.quantity, 0)
  const cardCount = countCards(draft.commander) + countCards(draft.mainboard)
  const size = targetSize(format)
  const sideLabel = sectionLabel('sideboard', format).toLowerCase()
  const addLabels: Record<SectionName, string> = {
    commander: needsCommander ? 'Search for your commander' : 'Search for a second commander',
    mainboard: 'Search cards to add to the mainboard',
    sideboard: `Search cards to add to the ${sideLabel}`,
  }
  const [bar, stuck] = useStuck<HTMLDivElement>()

  return (
    <>
      <ArtHeader art={look.cover}>
        <DeckHero
          card={draft.commander[0]}
          actions={
            <>
              <Switch
                label="Public"
                description="Anyone can find and view it"
                checked={isPublic}
                disabled={publishing}
                onChange={(e) => setVisibility(e.currentTarget.checked)}
                className={classes.publicSwitch}
              />
              <Group gap="xs" wrap="nowrap">
                {isPublic && (
                  <>
                    <CopyButton value={`${window.location.origin}/deck/${saved.id}`}>
                      {({ copied, copy }) => (
                        <Button
                          variant="default"
                          size="sm"
                          leftSection={copied ? <Icon name="check" size={16} /> : <Icon name="link" size={16} />}
                          onClick={copy}
                        >
                          {copied ? 'Link copied' : 'Copy link'}
                        </Button>
                      )}
                    </CopyButton>
                    <Button component={Link} to={`/deck/${saved.id}`} variant="subtle" size="sm" leftSection={<Icon name="open_in_new" size={16} />}>
                      Public page
                    </Button>
                  </>
                )}
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="default" size="lg" aria-label="Deck actions">
                      <Icon name="more_horiz" size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item component="a" href={`/api/decks/${saved.id}/export`} download leftSection={<Icon name="download" size={16} />}>
                      Export decklist
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="danger" leftSection={<Icon name="delete" size={16} />} onClick={deleteDialog.open}>
                      Delete deck
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </>
          }
        >
          <Anchor component={Link} to="/decks" size="sm" c="dark.1">
            Your decks
          </Anchor>
          <EditableTitle name={draft.name} label="Deck name" renameLabel="Rename deck" onRename={(name) => setDraft((d) => ({ ...d, name }))} />
          <Group gap="md" mt="sm" className={classes.facts}>
            <Select
              aria-label="Format"
              size="xs"
              variant="filled"
              data={formats}
              value={format}
              allowDeselect={false}
              onChange={(f) => f && setDraft((d) => ({ ...d, format: f }))}
              className={classes.format}
              comboboxProps={{ width: 160 }}
            />
            {look.colors.length > 0 && (
              <span className={classes.pips} aria-label={`Colours: ${look.colors.join('')}`}>
                <ManaSymbols text={look.colors.map((c) => `{${c}}`).join('')} />
              </span>
            )}
            <span data-testid="deck-count">
              {size ? `${cardCount} / ${size}` : cardCount} {cardCount === 1 && !size ? 'card' : 'cards'}
              {draft.sideboard.length > 0 && ` + ${countCards(draft.sideboard)} ${sideLabel}`}
            </span>
            <span data-testid="deck-value">≈ {formatPrice(value, currency)}</span>
          </Group>
          <Group gap="sm" mt="md" align="flex-start">
            <Legality draft={draft} />
            <SaveStatus state={state} onRetry={() => save(json)} />
          </Group>
        </DeckHero>
      </ArtHeader>

      <Container size="lg">
        {error && (
          <Alert color="danger" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {all.length > 0 && <DeckStatsLine deck={draft} />}

        {/* Where to add and the search stay under the header while the deck scrolls; compare and the view don't. */}
        <div ref={bar} className={`${sticky} ${classes.toolbar}`} data-stuck={stuck || undefined}>
          <div className={classes.addGroup}>
            <SegmentedControl
              aria-label="Add to"
              size="sm"
              value={addTo}
              onChange={(s) => setTarget(s as SectionName)}
              data={sections.map((s) => ({
                value: s,
                label: s === 'commander' ? 'Commander' : s === 'mainboard' ? 'Main' : sectionLabel(s, format),
                disabled: s === 'commander' && draft.commander.length >= 2,
              }))}
              className={classes.addTo}
            />
            <div className={classes.search}>
              <CardPicker
                key={addTo}
                label="Add a card"
                placeholder={addLabels[addTo]}
                commander={addTo === 'commander'}
                autoFocus={all.length === 0}
                onPick={add}
              />
            </div>
          </div>
        </div>
        <div className={classes.viewRow}>
          {all.length > 0 && <CompareWithCollection deckId={saved.id} />}
          <Group gap="sm" className={classes.viewGroup}>
            <SegmentedControl
              aria-label="View"
              size="xs"
              value={view}
              onChange={(v) => setView(v as View)}
              data={[
                { label: 'List', value: 'list' },
                { label: 'Gallery', value: 'gallery' },
                { label: 'Stacks', value: 'stacks' },
              ]}
            />
            {view === 'gallery' && <GallerySizeControl size={gallerySize} onChange={setGallerySize} />}
          </Group>
        </div>
        {notice && (
          <Text size="sm" c="warning" role="status" mb="md">
            {notice}
          </Text>
        )}

        {all.length === 0 ? (
          <EmptyState title="This deck is empty">
            {needsCommander
              ? 'Start with your commander: search above for a legendary creature. Then add the rest of the deck.'
              : 'Search above to add cards. Type a number first to add several copies, like "4 lightning bolt".'}
          </EmptyState>
        ) : (
          sections.map((name) => (
            <DeckSection
              key={name}
              name={name}
              format={format}
              entries={draft[name]}
              empty={
                name === 'commander'
                  ? 'No commander yet. Choose "Commander" above and search, or use "Set as commander" on a card.'
                  : name === 'sideboard'
                    ? isSingleton(format)
                      ? 'Cards you are considering go here. They don’t count towards the deck.'
                      : 'Nothing in the sideboard.'
                    : 'Search above to add cards.'
              }
              stacks={
                draft[name].length === 0 || view === 'list' ? undefined : view === 'stacks' ? (
                  <DeckStacks section={name} entries={draft[name]} actions={stackActions(name)} />
                ) : (
                  <DeckGallery section={name} entries={draft[name]} actions={stackActions(name)} currency={currency} size={gallerySize} />
                )
              }
              currency={currency}
              onOpen={open(name)}
            />
          ))
        )}
      </Container>

      {editing && edited && (
        <CardPanel
          key={`${editing.section}:${editing.key}`}
          initial={{ card: edited.card, copies: edited.quantity, finish: edited.finish, section: editing.section }}
          sections={[editing.section, ...moveTargets(editing.section, edited).map((t) => t.to)].map((s) => ({
            value: s,
            label: s === 'commander' ? 'Commander' : sectionLabel(s, format),
          }))}
          // Never fewer than it has where it is: a deck over the limit (the legality check says so) isn't cut by a save.
          maxCopies={(values) => {
            const most = maxCopies(format, values.section as SectionName, values.card)
            return values.section === editing.section ? Math.max(most, edited.quantity) : most
          }}
          removeLabel="Remove from deck"
          onSave={async (values) => {
            saveEntry(editing.section, editing.key, values)
            setEditing(null)
          }}
          onRemove={() => {
            setEditing(null)
            removeEntry(editing.section, edited)
          }}
          onClose={() => setEditing(null)}
        />
      )}

      <DeleteDeck
        deck={saved}
        opened={deleting}
        onClose={deleteDialog.close}
        onDeleted={() => {
          leaving.current = true
          navigate('/decks', { replace: true })
        }}
      />

      <Modal opened={leaveFailed} onClose={stay} title="Leave without saving?" centered>
        <Stack gap="md">
          <Text>Your latest changes to this deck couldn't be saved.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={stay}>
              Stay
            </Button>
            <Button
              color="danger"
              onClick={() => {
                setLeaveFailed(false)
                blocker.proceed?.()
              }}
            >
              Leave without saving
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}

export default function DeckPage() {
  const { id } = useParams()
  const { account } = useAuth()
  const location = useLocation()
  // undefined while loading; null when there's no such deck (or it isn't this user's); 'signed-out' on a 401;
  // 'failed' when the API didn't answer properly.
  const [deck, setDeck] = useState<DeckDetail | null | 'signed-out' | 'failed'>()

  useEffect(() => {
    if (!account) return
    let current = true
    getJson(`/api/decks/${id}`)
      .then((d) => current && setDeck(d))
      .catch((e) => {
        if (!current) return
        const status = e instanceof ApiError ? e.status : 0
        setDeck(status === 404 ? null : status === 401 ? 'signed-out' : 'failed')
      })
    return () => {
      current = false
    }
  }, [id, account])

  if (account === undefined) return null
  if (account === null || deck === 'signed-out') {
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />
  }
  if (deck === undefined) {
    return (
      <Container size="lg" py="xl" aria-busy="true">
        <Skeleton height={48} width="50%" mb="xl" />
        <Skeleton height={300} />
      </Container>
    )
  }
  if (deck === 'failed') {
    return (
      <Container size="lg" py="xl">
        <Alert color="danger" title="Your deck didn't load" role="alert">
          Deckino didn't respond. Reload the page to try again.
        </Alert>
      </Container>
    )
  }
  if (deck === null) {
    return (
      <Container size="lg" py="xl">
        <Alert color="danger" title="Deck not found" role="alert">
          No deck of yours has this address. <Anchor component={Link} to="/decks">See your decks</Anchor>.
        </Alert>
      </Container>
    )
  }
  return <DeckEditor key={deck.id} saved={deck} onSaved={setDeck} />
}
