import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  HoverCard,
  List,
  Menu,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconCards,
  IconCircleCheck,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconTrash,
} from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useBlocker, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import type { CardDetail } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { PrintingSelect } from '../cards/PrintingSelect'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency, type Currency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols } from '../components/ManaSymbols'
import {
  countCards,
  deckLook,
  defaultFinish,
  entryKey,
  entryPrice,
  finishLabels,
  formatLabel,
  formats,
  groupByType,
  putEntry,
  toDeckCard,
  toRequest,
  type DeckDetail,
  type DeckEntry,
  type Finish,
  type SectionName,
} from './deck'
import classes from './DeckPage.module.css'

type Draft = Omit<DeckDetail, 'id' | 'isPublic' | 'createdAt' | 'updatedAt'>
type View = 'list' | 'gallery'

const sectionLabels: Record<SectionName, string> = { commander: 'Commander', mainboard: 'Mainboard', sideboard: 'Sideboard' }

const fetchCard = async (id: string) => toDeckCard(await getJson<CardDetail>(`/api/cards/${id}`))

interface EntryActions {
  onChange: (section: SectionName, entry: DeckEntry, next: DeckEntry) => void
  onPickPrinting: (section: SectionName, entry: DeckEntry, scryfallId: string) => void
  onMove: (section: SectionName, entry: DeckEntry, to: SectionName) => void
  onRemove: (section: SectionName, entry: DeckEntry) => void
}

function EntryRow({
  section,
  entry,
  moveTargets,
  currency,
  actions,
}: {
  section: SectionName
  entry: DeckEntry
  moveTargets: SectionName[]
  currency: Currency
  actions: EntryActions
}) {
  const { card } = entry
  return (
    <li className={classes.row} aria-label={card.name}>
      <NumberInput
        aria-label={`Quantity of ${card.name}`}
        size="xs"
        className={classes.quantity}
        min={1}
        max={99}
        clampBehavior="strict"
        allowDecimal={false}
        allowNegative={false}
        value={entry.quantity}
        onChange={(value) => typeof value === 'number' && value >= 1 && actions.onChange(section, entry, { ...entry, quantity: value })}
      />
      <HoverCard position="right" openDelay={150} disabled={!card.image}>
        <HoverCard.Target>
          <span className={classes.name}>
            <span className={classes.cardName}>{card.name}</span>
            {entry.finish !== 'nonfoil' && (
              <Badge size="xs" variant="gradient">
                {finishLabels[entry.finish]}
              </Badge>
            )}
          </span>
        </HoverCard.Target>
        <HoverCard.Dropdown p={0} className={classes.preview}>
          <CardImage src={card.image} alt={card.name} foil={entry.finish !== 'nonfoil'} />
        </HoverCard.Dropdown>
      </HoverCard>
      <span className={classes.mana}>
        <ManaSymbols text={card.manaCost} />
      </span>
      <div className={classes.controls}>
        <PrintingSelect entry={entry} className={classes.printing} onPick={(id) => actions.onPickPrinting(section, entry, id)} />
        <Select
          aria-label={`Finish of ${card.name}`}
          size="xs"
          className={classes.finish}
          data={card.finishes.map((f) => ({ value: f, label: finishLabels[f] }))}
          value={entry.finish}
          allowDeselect={false}
          disabled={card.finishes.length < 2}
          onChange={(f) => f && actions.onChange(section, entry, { ...entry, finish: f as Finish })}
        />
        <span className={classes.price}>{formatPrice(entryPrice(entry, currency), currency)}</span>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label={`More actions for ${card.name}`}>
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {moveTargets.map((to) => (
              <Menu.Item key={to} leftSection={<IconArrowsExchange size={16} />} onClick={() => actions.onMove(section, entry, to)}>
                Move to {sectionLabels[to].toLowerCase()}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => actions.onRemove(section, entry)}>
              Remove
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    </li>
  )
}

function Section({
  name,
  entries,
  view,
  sections,
  currency,
  actions,
  empty,
}: {
  name: SectionName
  entries: DeckEntry[]
  view: View
  sections: SectionName[]
  currency: Currency
  actions: EntryActions
  empty: string
}) {
  const groups = name === 'commander' ? [{ label: '', entries }] : groupByType(entries)
  const moveTargets = sections.filter((s) => s !== name)
  return (
    <section className={classes.section} aria-label={sectionLabels[name]}>
      <Title order={2} className={classes.sectionTitle}>
        {sectionLabels[name]} <span className={classes.count}>{countCards(entries)}</span>
      </Title>
      {entries.length === 0 && <Text c="dimmed">{empty}</Text>}
      {groups.map((group) => (
        <div key={group.label} className={classes.group}>
          {group.label && (
            <Title order={3} className={classes.groupTitle}>
              {group.label} <span className={classes.count}>{countCards(group.entries)}</span>
            </Title>
          )}
          {view === 'list' ? (
            <ul className={classes.rows}>
              {group.entries.map((entry) => (
                <EntryRow
                  key={entryKey(entry)}
                  section={name}
                  entry={entry}
                  moveTargets={moveTargets}
                  currency={currency}
                  actions={actions}
                />
              ))}
            </ul>
          ) : (
            <ul className={classes.gallery}>
              {group.entries.map((entry) => (
                <li key={entryKey(entry)} className={classes.galleryCard}>
                  <CardImage src={entry.card.image} alt={entry.card.name} foil={entry.finish !== 'nonfoil'} lazy />
                  {entry.quantity > 1 && <span className={classes.galleryQuantity}>{entry.quantity}×</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  )
}

// The draft's format warnings from the API, rechecked shortly after each change, saved or not. The last answer
// stays up while the next one loads; a failed check shows nothing rather than a wrong verdict.
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

  if (format === 'casual' || !result) return null
  return <LegalityAlert format={result.format} warnings={result.warnings} />
}

// "Legal in X", or "Not legal in X" with the reasons. Named by its title, the verdict.
export function LegalityAlert({ format, warnings }: { format: string; warnings: string[] }) {
  const props = { role: 'region', mb: 'lg' } as const
  return warnings.length === 0 ? (
    <Alert {...props} color="teal" icon={<IconCircleCheck />} title={`Legal in ${formatLabel(format)}`} />
  ) : (
    <Alert {...props} color="yellow" icon={<IconAlertTriangle />} title={`Not legal in ${formatLabel(format)}`}>
      <List size="sm" spacing={2}>
        {warnings.map((w) => (
          <List.Item key={w}>{w}</List.Item>
        ))}
      </List>
    </Alert>
  )
}

interface DeckComparison {
  owned: number
  missing: number
  cards: { oracleId: string; name: string; needed: number; owned: number; missing: number; card: DeckEntry['card'] }[]
}

// How the saved deck compares with the cards in the user's binders, and its missing cards onto the wishlist.
function CompareWithCollection({ deckId, unsaved }: { deckId: string; unsaved: boolean }) {
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

  return (
    <>
      <Button variant="default" size="xs" leftSection={<IconCards size={16} />} onClick={show}>
        Compare with my collection
      </Button>
      <Modal opened={open} onClose={dialog.close} title="Compared with your binders" centered size="lg">
        <Stack gap="md">
          {unsaved && (
            <Text size="sm" c="dimmed">
              This compares the deck as last saved.
            </Text>
          )}
          {result === undefined && <Skeleton height={160} aria-busy="true" />}
          {result === null && <Alert color="red" role="alert">The comparison didn't load. Try again.</Alert>}
          {result && (
            <>
              <Group gap="lg" data-testid="collection-totals">
                <Text fw={700} c="teal.4">
                  Owned {result.owned}
                </Text>
                <Text fw={700} c={result.missing ? 'pink.3' : 'dimmed'}>
                  Missing {result.missing}
                </Text>
              </Group>
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

function DeleteDeck({ deck, onDeleted }: { deck: DeckDetail; onDeleted: () => void }) {
  const [open, dialog] = useDisclosure()
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
    <>
      <Button color="red" variant="subtle" leftSection={<IconTrash size={16} />} onClick={dialog.open}>
        Delete deck
      </Button>
      <Modal opened={open} onClose={dialog.close} title={`Delete ${deck.name}?`} centered>
        <Stack gap="md">
          <Text>This permanently deletes the deck. It can't be undone.</Text>
          {error && <Alert color="red" role="alert">{error}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.close}>
              Keep deck
            </Button>
            <Button color="red" loading={deleting} onClick={remove}>
              Delete deck
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}

function DeckEditor({ saved, onSaved }: { saved: DeckDetail; onSaved: (deck: DeckDetail) => void }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<Draft>(saved)
  const [currency, setCurrency] = useCurrency()
  const [view, setView] = useState<View>('list')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const leaving = useRef(false) // set once the deck is deleted, so the redirect isn't blocked
  const [isPublic, setIsPublic] = useState(saved.isPublic)
  const [publishing, setPublishing] = useState(false)

  // Public or private saves at once, apart from the deck's unsaved edits.
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

  const dirty = JSON.stringify(toRequest(draft)) !== JSON.stringify(toRequest(saved))
  const blocker = useBlocker(() => dirty && !leaving.current)

  // Closing the tab or reloading with unsaved changes: the browser asks.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const sections: SectionName[] =
    draft.format === 'commander' || draft.commander.length > 0
      ? ['commander', 'mainboard', 'sideboard']
      : ['mainboard', 'sideboard']
  const editSection = (section: SectionName, change: (entries: DeckEntry[]) => DeckEntry[]) =>
    setDraft((d) => ({ ...d, [section]: change(d[section]) }))
  const without = (entries: DeckEntry[], entry: DeckEntry) => entries.filter((e) => entryKey(e) !== entryKey(entry))

  // Card data comes from the API; a failed lookup leaves the deck as it was.
  async function withCard(id: string, apply: (card: Awaited<ReturnType<typeof fetchCard>>) => void) {
    try {
      apply(await fetchCard(id))
    } catch {
      setError("That card didn't load. Try again.")
    }
  }

  const actions: EntryActions = {
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
    onMove: (section, entry, to) =>
      setDraft((d) => ({ ...d, [section]: without(d[section], entry), [to]: putEntry(d[to], entry) })),
    onRemove: (section, entry) => editSection(section, (entries) => without(entries, entry)),
  }

  const add = (id: string) =>
    withCard(id, (card) =>
      editSection('mainboard', (entries) => putEntry(entries, { scryfallId: card.id, quantity: 1, finish: defaultFinish(card), card })),
    )

  async function save() {
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      const body = toRequest(draft)
      const sent = JSON.stringify(body)
      const deck = await sendJson<DeckDetail>('PUT', `/api/decks/${saved.id}`, body)
      // Edits made while saving stay in the draft (and keep it unsaved).
      setDraft((current) => (JSON.stringify(toRequest(current)) === sent ? deck : current))
      onSaved(deck)
    } catch (e) {
      if (!(e instanceof ApiError)) setError("Deckino didn't respond. Your changes aren't saved yet: try again.")
      else if (e.status === 401) setError('You were logged out. Log in again in another tab, then save.')
      else {
        const { cards, ...fields } = e.fieldErrors
        setFieldErrors(fields)
        setError(cards ?? (Object.keys(fields).length ? null : e.message))
      }
    } finally {
      setSaving(false)
    }
  }

  const look = deckLook(draft)
  const all = [...draft.commander, ...draft.mainboard, ...draft.sideboard]
  const value = all.reduce((sum, e) => sum + (entryPrice(e, currency) ?? 0) * e.quantity, 0)
  const cardCount = countCards(draft.commander) + countCards(draft.mainboard)

  return (
    <>
      <ArtHeader art={look.cover}>
        <Anchor component={Link} to="/decks" size="sm" c="dark.1">
          Your decks
        </Anchor>
        <Title order={1} mt={6} className={classes.title}>
          {draft.name.trim() || 'Untitled deck'}
        </Title>
        <Group gap="md" mt="sm" className={classes.facts}>
          <Badge variant="light" size="lg">
            {formatLabel(draft.format)}
          </Badge>
          {look.colors.length > 0 && (
            <span className={classes.pips} aria-label={`Colours: ${look.colors.join('')}`}>
              <ManaSymbols text={look.colors.map((c) => `{${c}}`).join('')} />
            </span>
          )}
          <span data-testid="deck-count">
            {cardCount} {cardCount === 1 ? 'card' : 'cards'}
            {draft.sideboard.length > 0 && ` + ${countCards(draft.sideboard)} sideboard`}
          </span>
          <span data-testid="deck-value">≈ {formatPrice(value, currency)}</span>
        </Group>
      </ArtHeader>

      <Container size="lg">
        <div className={classes.toolbar}>
          <TextInput
            label="Deck name"
            className={classes.nameInput}
            maxLength={100}
            value={draft.name}
            error={fieldErrors.name}
            onChange={(e) => {
              const name = e.currentTarget.value
              setDraft((d) => ({ ...d, name }))
            }}
          />
          <Select
            label="Format"
            data={formats}
            value={draft.format}
            allowDeselect={false}
            error={fieldErrors.format}
            onChange={(format) => format && setDraft((d) => ({ ...d, format }))}
            w={170}
          />
          <Group gap="sm" className={classes.saveGroup}>
            <Button variant="gradient" onClick={save} loading={saving} disabled={!dirty}>
              Save
            </Button>
            <Text size="sm" c={dirty ? 'pink.3' : 'dimmed'} role="status">
              {dirty ? 'Unsaved changes' : 'All changes saved'}
            </Text>
          </Group>
          <Switch
            label="Public"
            description="Anyone can find and view it"
            checked={isPublic}
            disabled={publishing}
            onChange={(e) => setVisibility(e.currentTarget.checked)}
          />
          {isPublic && (
            <Button component={Link} to={`/deck/${saved.id}`} variant="subtle" leftSection={<IconExternalLink size={16} />}>
              Public page
            </Button>
          )}
          <Button component="a" href={`/api/decks/${saved.id}/export`} download variant="subtle" color="gray" leftSection={<IconDownload size={16} />}>
            Export
          </Button>
          <DeleteDeck
            deck={saved}
            onDeleted={() => {
              leaving.current = true
              navigate('/decks', { replace: true })
            }}
          />
        </div>

        {error && (
          <Alert color="red" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Legality draft={draft} />

        <Group justify="space-between" align="flex-end" gap="md" mb="lg">
          <div className={classes.search}>
            <CardPicker label="Add a card" placeholder="Add a card to the mainboard" onPick={add} />
          </div>
          <Group gap="sm">
            <CompareWithCollection deckId={saved.id} unsaved={dirty} />
            <SegmentedControl
              aria-label="View"
              size="xs"
              value={view}
              onChange={(v) => setView(v as View)}
              data={[
                { label: 'List', value: 'list' },
                { label: 'Gallery', value: 'gallery' },
              ]}
            />
            <CurrencyToggle currency={currency} onChange={setCurrency} />
          </Group>
        </Group>

        {all.length === 0 ? (
          <EmptyState title="This deck is empty">
            Search for a card above to add it. Each card's menu moves it to the{' '}
            {draft.format === 'commander' ? 'commander or sideboard' : 'sideboard'}.
          </EmptyState>
        ) : (
          sections.map((name) => (
            <Section
              key={name}
              name={name}
              entries={draft[name]}
              view={view}
              sections={sections}
              currency={currency}
              actions={actions}
              empty={
                name === 'commander'
                  ? 'Choose a commander from a card\'s menu: "Move to commander".'
                  : name === 'sideboard'
                    ? 'Nothing in the sideboard.'
                    : 'Search above to add cards.'
              }
            />
          ))
        )}
      </Container>

      <Modal opened={blocker.state === 'blocked'} onClose={() => blocker.reset?.()} title="Leave without saving?" centered>
        <Stack gap="md">
          <Text>Your changes to this deck aren't saved yet.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => blocker.reset?.()}>
              Stay
            </Button>
            <Button color="red" onClick={() => blocker.proceed?.()}>
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
