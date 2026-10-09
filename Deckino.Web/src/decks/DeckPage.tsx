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
  NumberInput,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconArrowsExchange,
  IconCards,
  IconCheck,
  IconCloudCheck,
  IconCrown,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconLink,
  IconLoader2,
  IconPhoto,
  IconTrash,
} from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useBlocker, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import type { CardDetail } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { PrintingPicker } from '../cards/PrintingPicker'
import { PrintingSelect } from '../cards/PrintingSelect'
import { ArtHeader } from '../components/ArtHeader'
import { formatPrice, useCurrency, type Currency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { EditableTitle } from '../components/EditableTitle'
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
  finishLabels,
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
  type Finish,
  type SectionName,
} from './deck'
import { CardName, DeckHero, DeckSection, LegalityAlert } from './DeckParts'
import { DeckGallery, GallerySizeControl, useGallerySize } from './DeckGallery'
import { DeckStacks, type StackActions } from './DeckStacks'
import { DeckStats } from './DeckStats'
import classes from './DeckPage.module.css'

export { LegalityAlert } from './DeckParts'

type Draft = Omit<DeckDetail, 'id' | 'isPublic' | 'createdAt' | 'updatedAt'>
type View = 'list' | 'gallery' | 'stacks'
type SaveState = 'saved' | 'pending' | 'saving' | 'failed'

const fetchCard = async (id: string) => toDeckCard(await getJson<CardDetail>(`/api/cards/${id}`))
// A card that can lead a deck, or join a commander that chooses a Background.
const canLead = (card: DeckCard) => card.canBeCommander || card.typeLine?.includes('Background') === true

// List, gallery or stacks, remembered in this browser like the currency.
const useView = () => useRemembered<View>('deckino.deckView', ['list', 'gallery', 'stacks'], 'list')

interface RowActions {
  onChange: (section: SectionName, entry: DeckEntry, next: DeckEntry) => void
  onPickPrinting: (section: SectionName, entry: DeckEntry, scryfallId: string) => void
  onMove: (section: SectionName, entry: DeckEntry, to: SectionName) => void
  onRemove: (section: SectionName, entry: DeckEntry) => void
  moveTargets: (section: SectionName, entry: DeckEntry) => { to: SectionName; label: string }[]
}

// One card in the list: its quantity (only where more than one copy is allowed), name, cost, printing, finish
// (only when the printing has a choice), price and a menu.
function EntryCells({
  section,
  entry,
  format,
  currency,
  actions,
}: {
  section: SectionName
  entry: DeckEntry
  format: string
  currency: Currency
  actions: RowActions
}) {
  const { card } = entry
  const max = maxCopies(format, section, card)
  const [picking, picker] = useDisclosure()
  return (
    <>
      <PrintingPicker
        opened={picking}
        onClose={picker.close}
        scryfallId={entry.scryfallId}
        cardName={card.name}
        currency={currency}
        onPick={(id) => actions.onPickPrinting(section, entry, id)}
      />
      <span className={classes.quantityCell}>
        {section === 'commander' ? (
          <Tooltip label="Commander">
            <IconCrown size={18} className={classes.crown} aria-label="Commander" />
          </Tooltip>
        ) : max === 1 && entry.quantity === 1 ? (
          <span className={classes.single} aria-label={`Quantity of ${card.name}: 1`}>
            1
          </span>
        ) : (
          <NumberInput
            aria-label={`Quantity of ${card.name}`}
            size="xs"
            className={classes.quantity}
            min={1}
            max={Math.max(max, entry.quantity)}
            clampBehavior="strict"
            allowDecimal={false}
            allowNegative={false}
            value={entry.quantity}
            onChange={(value) => typeof value === 'number' && value >= 1 && actions.onChange(section, entry, { ...entry, quantity: value })}
          />
        )}
      </span>
      <CardName entry={entry} />
      <span className={classes.mana}>
        <ManaSymbols text={card.manaCost} />
      </span>
      <div className={classes.controls}>
        <PrintingSelect entry={entry} className={classes.printing} onPick={(id) => actions.onPickPrinting(section, entry, id)} />
        {card.finishes.length > 1 ? (
          <Select
            aria-label={`Finish of ${card.name}`}
            size="xs"
            className={classes.finish}
            data={card.finishes.map((f) => ({ value: f, label: finishLabels[f] }))}
            value={entry.finish}
            allowDeselect={false}
            onChange={(f) => f && actions.onChange(section, entry, { ...entry, finish: f as Finish })}
          />
        ) : (
          <span className={classes.finish} aria-hidden="true" />
        )}
        <span className={classes.price}>{formatPrice(entryPrice(entry, currency), currency)}</span>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label={`More actions for ${card.name}`}>
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {actions.moveTargets(section, entry).map(({ to, label }) => (
              <Menu.Item
                key={to}
                leftSection={to === 'commander' ? <IconCrown size={16} /> : <IconArrowsExchange size={16} />}
                onClick={() => actions.onMove(section, entry, to)}
              >
                {label}
              </Menu.Item>
            ))}
            <Menu.Item leftSection={<IconPhoto size={16} />} onClick={picker.open}>
              Change printing…
            </Menu.Item>
            <Menu.Item component={Link} to={`/cards/${card.id}`} leftSection={<IconExternalLink size={16} />}>
              Open card page
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => actions.onRemove(section, entry)}>
              Remove
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    </>
  )
}

// The draft's format warnings from the API, rechecked shortly after each change. The last answer stays up while
// the next one loads; a failed check shows nothing rather than a wrong verdict.
function Legality({ draft }: { draft: Draft }) {
  const { format, cards } = toRequest(draft)
  const key = JSON.stringify({ format, cards })
  const [result, setResult] = useState<{ format: string; warnings: string[] } | null>(null)

  useEffect(() => {
    let current = true
    const wait = setTimeout(() => {
      const body = JSON.parse(key) as { format: string }
      sendJson<string[]>('POST', '/api/decks/legality', body)
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

interface DeckComparison {
  owned: number
  missing: number
  cards: { oracleId: string; name: string; needed: number; owned: number; missing: number; card: DeckEntry['card'] }[]
}

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
    getJson<DeckComparison>(`/api/decks/${deckId}/collection`)
      .then(setResult)
      .catch(() => setResult(null))
  }

  async function addMissing() {
    setAdding(true)
    setError(null)
    try {
      setAdded((await sendJson<{ added: number }>('POST', `/api/decks/${deckId}/collection/wishlist`)).added)
    } catch {
      setError("The wishlist wasn't changed. Try again.")
    } finally {
      setAdding(false)
    }
  }

  const share = result && result.owned + result.missing > 0 ? (result.owned / (result.owned + result.missing)) * 100 : 0
  return (
    <>
      <Button variant="default" size="xs" leftSection={<IconCards size={16} />} onClick={show}>
        Compare with my collection
      </Button>
      <Modal opened={open} onClose={dialog.close} title="Compared with your binders" centered size="lg">
        <Stack gap="md">
          {result === undefined && <Skeleton height={160} aria-busy="true" />}
          {result === null && <Alert color="red" role="alert">The comparison didn't load. Try again.</Alert>}
          {result && (
            <>
              <div data-testid="collection-totals" className={classes.totals}>
                <Group gap="lg">
                  <Text fw={700} c="teal.4">
                    Owned {result.owned}
                  </Text>
                  <Text fw={700} c={result.missing ? 'pink.3' : 'dimmed'}>
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
                      <Badge color="pink" variant="light">
                        {c.missing} missing
                      </Badge>
                    ) : (
                      <Badge color="teal" variant="light">
                        Owned
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
              {error && <Alert color="red" role="alert">{error}</Alert>}
              {added !== null && (
                <Alert color="teal" role="status">
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
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Keep deck
          </Button>
          <Button color="red" loading={deleting} onClick={remove}>
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
          <IconCloudCheck size={16} /> Saved
        </>
      )}
      {(state === 'pending' || state === 'saving') && (
        <>
          <IconLoader2 size={16} className={classes.spin} /> Saving…
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
  const [currency, setCurrency] = useCurrency()
  const [view, setView] = useView()
  const [gallerySize, setGallerySize] = useGallerySize()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState(saved.isPublic)
  const [publishing, setPublishing] = useState(false)
  const [deleting, deleteDialog] = useDisclosure()
  const [target, setTarget] = useState<SectionName>()
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
      const deck = await sendJson<DeckDetail>('PUT', `/api/decks/${saved.id}`, JSON.parse(body))
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
      setIsPublic((await sendJson<DeckDetail>('PUT', `/api/decks/${saved.id}/visibility`, { isPublic: value })).isPublic)
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

  const actions: RowActions = {
    moveTargets,
    onChange: (section, entry, next) =>
      editSection(section, (entries) => {
        // A finish change can make the entry identical to another one: merge them.
        if (entryKey(next) !== entryKey(entry)) return putEntry(without(entries, entry), next)
        return entries.map((e) => (entryKey(e) === entryKey(entry) ? next : e))
      }),
    onPickPrinting: (section, entry, scryfallId) =>
      withCard(scryfallId, (card) =>
        editSection(section, (entries) => {
          // The entry as it is now: it may have changed, moved or gone while the card loaded.
          const current = entries.find((e) => entryKey(e) === entryKey(entry))
          if (!current) return entries
          const finish = card.finishes.includes(current.finish) ? current.finish : defaultFinish(card)
          return putEntry(without(entries, current), { ...current, scryfallId, finish, card })
        }),
      ),
    // A commander is one card: setting one moves a single copy, and the rest stay where they were.
    onMove: (section, entry, to) =>
      setDraft((d) => {
        const moving = to === 'commander' ? { ...entry, quantity: 1 } : entry
        const left = entry.quantity - moving.quantity
        const from = left > 0 ? d[section].map((e) => (entryKey(e) === entryKey(entry) ? { ...e, quantity: left } : e)) : without(d[section], entry)
        return { ...d, [section]: from, [to]: putEntry(d[to], moving) }
      }),
    onRemove: (section, entry) => editSection(section, (entries) => without(entries, entry)),
  }

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

  const stackActions = (section: SectionName): StackActions => ({
    canAdd: (entry) => entry.quantity < maxCopies(format, section, entry.card),
    moveTargets: (entry) => moveTargets(section, entry),
    onQuantity: (entry, quantity) => actions.onChange(section, entry, { ...entry, quantity }),
    onMove: (entry, to) => actions.onMove(section, entry, to),
    onRemove: (entry) => actions.onRemove(section, entry),
    onPrinting: (entry, id) => actions.onPickPrinting(section, entry, id),
    currency,
  })

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
                          leftSection={copied ? <IconCheck size={16} /> : <IconLink size={16} />}
                          onClick={copy}
                        >
                          {copied ? 'Link copied' : 'Copy link'}
                        </Button>
                      )}
                    </CopyButton>
                    <Button component={Link} to={`/deck/${saved.id}`} variant="subtle" size="sm" leftSection={<IconExternalLink size={16} />}>
                      Public page
                    </Button>
                  </>
                )}
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="default" size="lg" aria-label="Deck actions">
                      <IconDots size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item component="a" href={`/api/decks/${saved.id}/export`} download leftSection={<IconDownload size={16} />}>
                      Export decklist
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={deleteDialog.open}>
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
          <Alert color="red" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {all.length > 0 && <DeckStats deck={draft} />}

        <div className={classes.toolbar}>
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
          <Group gap="sm" className={classes.viewGroup}>
            {all.length > 0 && <CompareWithCollection deckId={saved.id} />}
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
            <CurrencyToggle currency={currency} onChange={setCurrency} />
          </Group>
        </div>
        {notice && (
          <Text size="sm" c="pink.2" role="status" mb="md">
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
              renderRow={(entry) => <EntryCells section={name} entry={entry} format={format} currency={currency} actions={actions} />}
            />
          ))
        )}
      </Container>

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
              color="red"
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
    getJson<DeckDetail>(`/api/decks/${id}`)
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
        <Alert color="red" title="Your deck didn't load" role="alert">
          Deckino didn't respond. Reload the page to try again.
        </Alert>
      </Container>
    )
  }
  if (deck === null) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Deck not found" role="alert">
          No deck of yours has this address. <Anchor component={Link} to="/decks">See your decks</Anchor>.
        </Alert>
      </Container>
    )
  }
  return <DeckEditor key={deck.id} saved={deck} onSaved={setDeck} />
}
