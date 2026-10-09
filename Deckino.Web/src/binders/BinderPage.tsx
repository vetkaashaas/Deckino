import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Chip,
  Container,
  Group,
  HoverCard,
  Menu,
  Modal,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import {
  IconArrowsExchange,
  IconCopy,
  IconDots,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import type { CardDetail } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { EditableTitle } from '../components/EditableTitle'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { EmptyState } from '../components/EmptyState'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { entryPrice, finishLabels, type Finish } from '../decks/deck'
import {
  conditions,
  groupCopies,
  languages,
  languageLabel,
  printingLabel,
  type BinderCard,
  type BinderDetail,
  type BinderSummary,
  type CardGroup,
} from './binder'
import classes from './BinderPage.module.css'
import { CopyForm, type CopyValues } from './CopyForm'

const toRequest = ({ scryfallId, finish, condition, language, notes }: CopyValues) => ({
  scryfallId,
  finish,
  condition,
  language,
  notes,
})
const valuesOf = (copy: BinderCard): CopyValues => ({
  scryfallId: copy.scryfallId,
  finish: copy.finish,
  condition: copy.condition,
  language: copy.language,
  notes: copy.notes ?? '',
  copies: 1,
})
const conditionLabel = (code: string) => conditions.find((c) => c.value === code)?.label ?? code

type Dialog = { kind: 'add'; values: CopyValues } | { kind: 'edit'; copy: BinderCard } | { kind: 'delete' } | null

function CopyRow({
  group,
  selected,
  onSelect,
  targets,
  actions,
  price,
  busy,
}: {
  price: string
  busy: boolean
  group: CardGroup
  selected: boolean
  onSelect: (selected: boolean) => void
  targets: BinderSummary[]
  actions: {
    addCopy: (copy: BinderCard) => void
    edit: (copy: BinderCard) => void
    move: (ids: string[], to: string) => void
    remove: (copy: BinderCard) => void
  }
}) {
  const copy = group.copies[0]
  const { card } = copy
  return (
    <li className={classes.row} aria-label={card.name}>
      <Checkbox className={classes.select} aria-label={`Select ${card.name}`} checked={selected} onChange={(e) => onSelect(e.currentTarget.checked)} />
      <span className={classes.count} aria-label={`${group.copies.length} copies`}>
        {group.copies.length}×
      </span>
      <img className={classes.thumb} src={card.smallImage ?? card.image ?? undefined} alt="" loading="lazy" />
      <div className={classes.name}>
        <HoverCard position="right" openDelay={150} disabled={!card.image}>
          <HoverCard.Target>
            <span className={classes.cardName}>{card.name}</span>
          </HoverCard.Target>
          <HoverCard.Dropdown p={0} className={classes.preview}>
            <CardImage src={card.image} alt={card.name} foil={copy.finish !== 'nonfoil'} />
          </HoverCard.Dropdown>
        </HoverCard>
        <Text size="xs" c="dimmed" className={classes.details}>
          {printingLabel(card)}
          {copy.notes && <> · {copy.notes}</>}
        </Text>
      </div>
      <Group gap={6} className={classes.badges}>
        {copy.finish !== 'nonfoil' && (
          <Badge size="sm" variant="gradient">
            {finishLabels[copy.finish]}
          </Badge>
        )}
        <Badge size="sm" variant="default" title={conditionLabel(copy.condition)}>
          {copy.condition}
        </Badge>
        <Badge size="sm" variant="default">
          {languageLabel(copy.language)}
        </Badge>
        <span className={classes.price}>{price}</span>
      </Group>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon className={classes.menu} variant="subtle" color="gray" disabled={busy} aria-label={`More actions for ${card.name}`}>
            <IconDots size={18} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconPlus size={16} />} onClick={() => actions.addCopy(copy)}>
            Add a copy
          </Menu.Item>
          <Menu.Item leftSection={<IconEdit size={16} />} onClick={() => actions.edit(copy)}>
            Edit {group.copies.length > 1 ? 'one copy' : 'card'}
          </Menu.Item>
          {targets.length > 0 && <Menu.Label>Move {group.copies.length > 1 ? 'one copy ' : ''}to</Menu.Label>}
          {targets.map((t) => (
            <Menu.Item key={t.id} leftSection={<IconArrowsExchange size={16} />} onClick={() => actions.move([copy.id], t.id)}>
              {t.name}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => actions.remove(copy)}>
            Remove {group.copies.length > 1 ? 'one copy' : 'card'}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </li>
  )
}

function BinderEditor({ initial }: { initial: BinderDetail }) {
  const navigate = useNavigate()
  const [binder, setBinder] = useState(initial)
  const [others, setOthers] = useState<BinderSummary[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, copiedNote] = useDisclosure()
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    getJson<BinderSummary[]>('/api/binders')
      .then((all) => setOthers(all.filter((b) => b.id !== initial.id)))
      .catch(() => setOthers([]))
  }, [initial.id])

  const groups = groupCopies(binder.cards)
  const url = `/api/binders/${binder.id}`

  // Every change saves straight away and returns the binder as it now is. One at a time: each waits for the one
  // before (quick adds can come faster than the API answers), so responses can't arrive out of order and show an
  // older binder.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.current.then(task)
    queue.current = next.catch(() => {}) // a failed change doesn't stop the ones after it
    return next
  }
  // A change from the page: its failure shows above the cards. (The dialogs show their own, so they enqueue directly.)
  function run(action: () => Promise<BinderDetail>): Promise<boolean> {
    return enqueue(async () => {
      setBusy(true)
      setError(null)
      try {
        setBinder(await action())
        return true
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Deckino didn't respond. Try again.")
        return false
      } finally {
        setBusy(false)
      }
    })
  }

  const move = async (ids: string[], to: string) => {
    if (await run(() => sendJson<BinderDetail>('POST', `${url}/cards/move`, { cardIds: ids, toBinderId: to }))) {
      setSelected(new Set())
      setMoveTo(null)
    }
  }

  const actions = {
    addCopy: (copy: BinderCard) =>
      run(() => sendJson<BinderDetail>('POST', `${url}/cards`, { card: toRequest(valuesOf(copy)), copies: 1 })),
    edit: (copy: BinderCard) => setDialog({ kind: 'edit', copy }),
    move,
    remove: (copy: BinderCard) => run(() => sendJson<BinderDetail>('DELETE', `${url}/cards/${copy.id}`)),
  }

  // How quick-added cards go in: kept for this visit, so a stack of cards from the same box goes in fast.
  const [addAs, setAddAs] = useState({ condition: 'NM', language: 'en', foil: false, detailed: false })
  async function quickAdd(scryfallId: string, copies: number) {
    if (addAs.detailed) {
      const finish: Finish = addAs.foil ? 'foil' : 'nonfoil' // the form switches to a finish the printing has
      setDialog({ kind: 'add', values: { scryfallId, finish, condition: addAs.condition, language: addAs.language, notes: '', copies } })
      return
    }
    let card: CardDetail
    try {
      card = await getJson<CardDetail>(`/api/cards/${scryfallId}`)
    } catch {
      setError("That card didn't load. Try again.")
      return
    }
    const finishes = card.finishes as Finish[]
    // Foil asked for: the printing's foil (or etched) finish; otherwise its normal one, if it has one.
    const finish: Finish = addAs.foil
      ? (finishes.find((f) => f !== 'nonfoil') ?? finishes[0])
      : finishes.includes('nonfoil')
        ? 'nonfoil'
        : finishes[0]
    const values = { scryfallId, finish, condition: addAs.condition, language: addAs.language, notes: '', copies }
    if (await run(() => sendJson<BinderDetail>('POST', `${url}/cards`, { card: toRequest(values), copies }))) {
      const added = `Added ${copies > 1 ? `${copies}× ` : ''}${card.name}`
      // Foil asked for, but this printing isn't made in foil: say what went in instead.
      if (addAs.foil && finish === 'nonfoil') {
        notifications.show({ message: `${added} as Normal: this printing isn't made in foil.`, color: 'yellow', autoClose: 5000 })
      } else notifications.show({ message: `${added}.`, color: 'teal', autoClose: 2500 })
    }
  }

  const selectedIds = groups.filter((g) => selected.has(g.key)).flatMap((g) => g.copies.map((c) => c.id))
  const cover = binder.cards[0]?.card
  const count = binder.cards.length
  const value = binder.cards.reduce((sum, c) => sum + (entryPrice(c, currency) ?? 0), 0)
  const publicPath = `/binder/${binder.id}`

  return (
    <>
      <ArtHeader art={cover?.artCrop ?? cover?.image}>
        <div className={classes.hero}>
          <div className={classes.heroText}>
            <Anchor component={Link} to="/binders" size="sm" c="dark.1">
              Your binders
            </Anchor>
            <EditableTitle
              name={binder.name}
              label="Binder name"
              renameLabel="Rename binder"
              onRename={(name) => run(() => sendJson<BinderDetail>('PUT', url, { name }))}
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
                  run(() => sendJson<BinderDetail>('PUT', url, { isPublic }))
                }}
              />
              <Switch
                label="Selling"
                description="Marks the cards as for sale"
                checked={binder.isSelling}
                disabled={busy}
                onChange={(e) => {
                  const isSelling = e.currentTarget.checked
                  run(() => sendJson<BinderDetail>('PUT', url, { isSelling }))
                }}
              />
            </Group>
            <Group gap="xs" wrap="nowrap">
              {binder.isPublic && (
                <>
                  <Button
                    variant="default"
                    leftSection={<IconCopy size={16} />}
                    onClick={() => {
                      navigator.clipboard?.writeText(new URL(publicPath, window.location.origin).href).catch(() => {})
                      copiedNote.open()
                      setTimeout(copiedNote.close, 2000)
                    }}
                  >
                    {copied ? 'Link copied' : 'Copy link'}
                  </Button>
                  <Button component={Link} to={publicPath} variant="subtle" leftSection={<IconExternalLink size={16} />}>
                    Public page
                  </Button>
                </>
              )}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="default" size="lg" aria-label="Binder actions">
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item component="a" href={`${url}/export`} download leftSection={<IconDownload size={16} />}>
                    Export CSV
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setDialog({ kind: 'delete' })}>
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
          <Alert color="red" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Quick add: the card goes straight in with these details; each copy's menu edits it afterwards. */}
        <div className={classes.addBar} role="group" aria-label="Add cards">
          <div className={classes.search}>
            <CardPicker label="Add a card" placeholder={'Add a card: type "4 sol ring" for four copies'} onPick={quickAdd} />
          </div>
          <Group gap="xs" wrap="nowrap" className={classes.addAs}>
            <Select
              aria-label="Condition of added cards"
              size="md"
              w={92}
              data={conditions.map((c) => ({ value: c.value, label: c.value }))}
              value={addAs.condition}
              allowDeselect={false}
              onChange={(v) => v && setAddAs((a) => ({ ...a, condition: v }))}
            />
            <Select
              aria-label="Language of added cards"
              size="md"
              w={136}
              data={languages}
              value={addAs.language}
              allowDeselect={false}
              onChange={(v) => v && setAddAs((a) => ({ ...a, language: v }))}
              comboboxProps={{ width: 200 }}
            />
            <Chip checked={addAs.foil} onChange={(foil) => setAddAs((a) => ({ ...a, foil }))} size="md" variant="outline">
              Foil
            </Chip>
            <Chip checked={addAs.detailed} onChange={(detailed) => setAddAs((a) => ({ ...a, detailed }))} size="md" variant="outline">
              Pick printing & notes
            </Chip>
          </Group>
          <CurrencyToggle currency={currency} onChange={setCurrency} />
        </div>

        {selectedIds.length > 0 && (
          <div className={classes.selection} role="region" aria-label="Selection">
            <Text fw={500}>
              {selectedIds.length} {selectedIds.length === 1 ? 'card' : 'cards'} selected
            </Text>
            <Select
              aria-label="Move selected cards to"
              placeholder={others.length ? 'Choose a binder' : 'No other binders'}
              data={others.map((o) => ({ value: o.id, label: o.name }))}
              value={moveTo}
              onChange={setMoveTo}
              size="sm"
              w={220}
            />
            <Button disabled={!moveTo} loading={busy} onClick={() => moveTo && move(selectedIds, moveTo)}>
              Move
            </Button>
            <Button variant="subtle" color="gray" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {groups.length === 0 ? (
          <EmptyState title="This binder is empty">
            Search for a card above to add it, with its printing, finish, condition and language.
          </EmptyState>
        ) : (
          <ul className={classes.rows} aria-label="Cards">
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
                targets={others}
                actions={actions}
                price={formatPrice(entryPrice(group.copies[0], currency), currency)}
                busy={busy}
              />
            ))}
          </ul>
        )}
      </Container>

      {dialog?.kind === 'add' && (
        <CopyForm
          title="Add to binder"
          initial={dialog.values}
          withCopies
          submitLabel="Add"
          onClose={() => setDialog(null)}
          onSubmit={async (values) => {
            await enqueue(async () => setBinder(await sendJson<BinderDetail>('POST', `${url}/cards`, { card: toRequest(values), copies: values.copies })))
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <CopyForm
          title={`Edit ${dialog.copy.card.name}`}
          initial={valuesOf(dialog.copy)}
          withCopies={false}
          submitLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={async (values) => {
            const copy = dialog.copy
            await enqueue(async () => setBinder(await sendJson<BinderDetail>('PUT', `${url}/cards/${copy.id}`, toRequest(values))))
            setDialog(null)
          }}
        />
      )}
      <Modal opened={dialog?.kind === 'delete'} onClose={() => setDialog(null)} title={`Delete ${binder.name}?`} centered>
        <Stack gap="md">
          <Text>This permanently deletes the binder and the {count === 1 ? 'card' : `${count} cards`} in it. It can't be undone.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              Keep binder
            </Button>
            <Button
              color="red"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await sendJson('DELETE', url)
                  navigate('/binders', { replace: true })
                } catch {
                  setDialog(null)
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
    getJson<BinderDetail>(`/api/binders/${id}`)
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
        <Alert color="red" title="Your binder didn't load" role="alert">
          Deckino didn't respond. Reload the page to try again.
        </Alert>
      </Container>
    )
  }
  if (binder === null) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Binder not found" role="alert">
          No binder of yours has this address. <Anchor component={Link} to="/binders">See your binders</Anchor>.
        </Alert>
      </Container>
    )
  }
  return <BinderEditor key={binder.id} initial={binder} />
}
