import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
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
  TextInput,
  Title,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconArrowsExchange,
  IconCopy,
  IconDots,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { CardPicker } from '../cards/CardPicker'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { EmptyState } from '../components/EmptyState'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { entryPrice, finishLabels } from '../decks/deck'
import {
  conditions,
  groupCopies,
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

type Dialog =
  | { kind: 'add'; values: CopyValues }
  | { kind: 'edit'; copy: BinderCard }
  | { kind: 'rename' }
  | { kind: 'delete' }
  | null

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

function Rename({ name, onRename, onClose }: { name: string; onRename: (name: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  return (
    <Modal opened onClose={onClose} title="Rename binder" centered>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!value.trim()) return setError('Give the binder a name')
          setSaving(true)
          try {
            await onRename(value)
          } catch (err) {
            setError(err instanceof ApiError ? (err.fieldErrors.name ?? err.message) : "Deckino didn't respond. Try again.")
            setSaving(false)
          }
        }}
        noValidate
      >
        <Stack gap="md">
          <TextInput label="Binder name" maxLength={100} data-autofocus value={value} error={error} onChange={(e) => setValue(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" loading={saving}>
              Rename
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
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

  // Every change saves straight away and returns the binder as it now is. One at a time (the card menus are
  // disabled meanwhile), so responses can't arrive out of order and show an older binder.
  async function run(action: () => Promise<BinderDetail>) {
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

  const selectedIds = groups.filter((g) => selected.has(g.key)).flatMap((g) => g.copies.map((c) => c.id))
  const cover = binder.cards[0]?.card
  const count = binder.cards.length
  const value = binder.cards.reduce((sum, c) => sum + (entryPrice(c, currency) ?? 0), 0)
  const publicPath = `/binder/${binder.id}`

  return (
    <>
      <ArtHeader art={cover?.artCrop ?? cover?.image}>
        <Anchor component={Link} to="/binders" size="sm" c="dark.1">
          Your binders
        </Anchor>
        <Title order={1} mt={6} className={classes.title}>
          {binder.name}
        </Title>
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
      </ArtHeader>

      <Container size="lg">
        <div className={classes.toolbar}>
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
          <Group gap="xs" className={classes.toolbarActions}>
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
            <Button component="a" href={`${url}/export`} download variant="subtle" color="gray" leftSection={<IconDownload size={16} />}>
              Export CSV
            </Button>
            <Button variant="subtle" color="gray" leftSection={<IconPencil size={16} />} onClick={() => setDialog({ kind: 'rename' })}>
              Rename
            </Button>
            <Button color="red" variant="subtle" leftSection={<IconTrash size={16} />} onClick={() => setDialog({ kind: 'delete' })}>
              Delete binder
            </Button>
          </Group>
        </div>

        {error && (
          <Alert color="red" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <div className={classes.searchRow}>
          <div className={classes.search}>
            <CardPicker
            label="Add a card"
            placeholder="Add a card to this binder"
            onPick={(id) =>
              setDialog({
                kind: 'add',
                values: { scryfallId: id, finish: 'nonfoil', condition: 'NM', language: 'en', notes: '', copies: 1 },
              })
            }
            />
          </div>
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
            setBinder(await sendJson<BinderDetail>('POST', `${url}/cards`, { card: toRequest(values), copies: values.copies }))
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
            setBinder(await sendJson<BinderDetail>('PUT', `${url}/cards/${dialog.copy.id}`, toRequest(values)))
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <Rename
          name={binder.name}
          onClose={() => setDialog(null)}
          onRename={async (name) => {
            setBinder(await sendJson<BinderDetail>('PUT', url, { name }))
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
