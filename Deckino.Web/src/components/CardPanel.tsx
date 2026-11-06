import { ActionIcon, Alert, Anchor, Button, Chip, Drawer, Group, Menu, NumberInput, Select, Stack, Text, Textarea } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useState } from 'react'
import { Link } from 'react-router'
import { ApiError, getJson } from '../api'
import { conditions, languages, type Condition } from '../binders/binder'
import { printingLabel } from '../cards/api'
import { PrintingPicker } from '../cards/PrintingPicker'
import { defaultFinish, entryPrice, finishLabels, toDeckCard, type DeckCard, type Finish } from '../decks/deck'
import { CardImage } from './CardImage'
import { formatPrice, useCurrency } from './currency'
import { Icon } from './Icon'
import classes from './CardPanel.module.css'

// The app's card sheet, the one place a card is changed: a binder row, a deck card and a wishlist row all open it.
// A side panel on a wide screen, a sheet from the bottom on a phone. Condition, language and notes are for cards you
// own; `sections` for deck cards; `moveTo` for a binder's cards. Removing is a quiet link at the end, as it can be
// undone.

export interface PanelValues {
  card: DeckCard
  copies: number
  finish?: Finish
  condition?: Condition
  language?: string
  notes?: string
  section?: string
}

export function CardPanel({
  initial,
  unchecked = false,
  saveLabel = 'Save',
  removeLabel,
  sections,
  maxCopies = () => 99,
  moveTo,
  onSave,
  onRemove,
  onMove,
  onClose,
}: {
  initial: PanelValues
  /** A scanned card nobody has checked: say so by the printing. */
  unchecked?: boolean
  saveLabel?: string
  removeLabel?: string
  sections?: { value: string; label: string }[]
  /** The most copies allowed with these values (a commander is one card). */
  maxCopies?: (values: PanelValues) => number
  moveTo?: { value: string; label: string }[]
  onSave: (values: PanelValues) => Promise<void>
  onRemove?: () => void
  onMove?: (to: string) => void
  onClose: () => void
}) {
  const phone = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false })
  const [currency] = useCurrency()
  const [values, setValues] = useState(initial)
  const [picking, setPicking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (next: Partial<PanelValues>) => setValues((v) => ({ ...v, ...next }))
  const { card } = values
  const finish = values.finish ?? defaultFinish(card)
  const price = entryPrice({ finish, card }, currency)
  const most = maxCopies(values)
  const copies = Math.min(values.copies, most)

  async function choosePrinting(id: string) {
    setLoading(true)
    setError(null)
    try {
      const next = toDeckCard(await getJson(`/api/cards/${id}`))
      // The finish stays when the new printing comes in it.
      change({ card: next, finish: values.finish && (next.finishes.includes(values.finish) ? values.finish : defaultFinish(next)) })
    } catch {
      setError("That printing didn't load. Try again.")
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await onSave({ ...values, copies })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Deckino didn't respond. Try again.")
      setSaving(false)
    }
  }

  return (
    <Drawer
      opened
      onClose={onClose}
      position={phone ? 'bottom' : 'right'}
      size={phone ? '92%' : 440}
      title={initial.card.name}
      classNames={{ title: classes.title, content: classes.content }}
    >
      <Stack gap="lg">
        <div className={classes.head}>
          <div className={classes.picture}>
            <Link to={`/cards/${card.id}`} aria-label={`${card.name}, card details`}>
              <CardImage src={card.image} alt="" foil={finish !== 'nonfoil'} />
            </Link>
            <Button variant="default" size="xs" fullWidth leftSection={<Icon name="flip" size={16} />} onClick={() => setPicking(true)} loading={loading}>
              Change printing
            </Button>
          </div>
          <div className={classes.facts}>
            <Text size="sm" c="dimmed" data-testid="panel-printing">
              {printingLabel(card)}
            </Text>
            <Text className={classes.price}>{formatPrice(price, currency)}</Text>
            {copies > 1 && price !== null && (
              <Text size="sm" c="dimmed">
                each · {formatPrice(price * copies, currency)} for {copies}
              </Text>
            )}
            <Anchor component={Link} to={`/cards/${card.id}`} size="sm" fw={600}>
              Card details
            </Anchor>
          </div>
        </div>

        {unchecked && (
          <Text size="sm" c="warning">
            Some printings share this picture. Pick the one whose set symbol matches your card.
          </Text>
        )}
        {error && (
          <Alert color="danger" role="alert">
            {error}
          </Alert>
        )}

        {sections && values.section && (
          <Choice title="Part of the deck" options={sections} value={values.section} onChange={(section) => change({ section })} />
        )}
        {values.condition && (
          <Choice
            title="Condition"
            options={conditions}
            value={values.condition}
            onChange={(condition) => change({ condition: condition as Condition })}
          />
        )}
        {values.finish && card.finishes.length > 1 && (
          <Choice
            title="Finish"
            options={card.finishes.map((f) => ({ value: f, label: finishLabels[f] }))}
            value={values.finish}
            onChange={(f) => change({ finish: f as Finish })}
          />
        )}
        {values.language && (
          <Select
            label="Language"
            data={languages}
            value={values.language}
            allowDeselect={false}
            searchable
            onChange={(language) => language && change({ language })}
          />
        )}
        {values.notes !== undefined && (
          <Textarea
            label="Notes"
            description="Only you see notes."
            maxLength={500}
            autosize
            minRows={2}
            value={values.notes}
            onChange={(e) => change({ notes: e.currentTarget.value })}
          />
        )}

        <Group justify="space-between">
          <Text fw={600}>Copies</Text>
          <Group gap="sm">
            <ActionIcon variant="default" size="lg" aria-label="One fewer copy" disabled={copies <= 1} onClick={() => change({ copies: copies - 1 })}>
              <Icon name="remove" size={20} />
            </ActionIcon>
            {/* Typed as well as stepped: a deck can want 30 Forests. */}
            <NumberInput
              aria-label="Copies"
              value={copies}
              min={1}
              max={most}
              clampBehavior="strict"
              allowDecimal={false}
              allowNegative={false}
              hideControls
              w={64}
              classNames={{ input: classes.count }}
              onChange={(n) => typeof n === 'number' && n >= 1 && change({ copies: n })}
            />
            <ActionIcon variant="default" size="lg" aria-label="One more copy" disabled={copies >= most} onClick={() => change({ copies: copies + 1 })}>
              <Icon name="add" size={20} />
            </ActionIcon>
          </Group>
        </Group>

        <Group grow>
          <Button variant="gradient" onClick={save} loading={saving} disabled={loading}>
            {saveLabel}
          </Button>
          {moveTo && moveTo.length > 0 && onMove && (
            <Menu position="top" withinPortal>
              <Menu.Target>
                <Button variant="default" leftSection={<Icon name="drive_file_move" size={18} />} disabled={saving}>
                  Move
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Move to</Menu.Label>
                {moveTo.map((t) => (
                  <Menu.Item key={t.value} onClick={() => onMove(t.value)}>
                    {t.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
        {onRemove && removeLabel && (
          <Button variant="subtle" color="danger" leftSection={<Icon name="delete" size={18} />} onClick={onRemove} disabled={saving} className={classes.remove}>
            {removeLabel}
          </Button>
        )}
      </Stack>

      <PrintingPicker
        opened={picking}
        onClose={() => setPicking(false)}
        scryfallId={card.id}
        cardName={card.name}
        currency={currency}
        onPick={choosePrinting}
      />
    </Drawer>
  )
}

// A short set of choices as chips, the chosen one filled.
function Choice({
  title,
  options,
  value,
  onChange,
}: {
  title: string
  options: readonly { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div role="radiogroup" aria-label={title}>
      <Text fw={600} mb={8}>
        {title}
      </Text>
      <Chip.Group value={value} onChange={(v) => typeof v === 'string' && onChange(v)}>
        <Group gap={8}>
          {options.map((o) => (
            <Chip key={o.value} value={o.value} size="sm">
              {o.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </div>
  )
}
