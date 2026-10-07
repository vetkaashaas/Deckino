import { Alert, Button, Group, Modal, NumberInput, Select, Stack, Textarea } from '@mantine/core'
import { useEffect, useState } from 'react'
import { ApiError, getJson } from '../api'
import { printingLabel, type CardDetail } from '../cards/api'
import { finishLabels, type Finish } from '../decks/deck'
import { conditions, languages } from './binder'

export interface CopyValues {
  scryfallId: string
  finish: Finish
  condition: string
  language: string
  notes: string
  copies: number
}

// Adds physical copies of a card, or edits one copy: printing, finish, condition, language and notes.
// The printing's details load from the catalogue, so its finishes and other printings are always current.
export function CopyForm({
  title,
  initial,
  withCopies,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string
  initial: CopyValues
  withCopies: boolean
  submitLabel: string
  onSubmit: (values: CopyValues) => Promise<void>
  onClose: () => void
}) {
  const [values, setValues] = useState(initial)
  const [card, setCard] = useState<CardDetail>()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    getJson<CardDetail>(`/api/cards/${values.scryfallId}`)
      .then((c) => {
        if (!current) return
        setCard(c)
        // A printing that doesn't come in the chosen finish takes its usual one.
        setValues((v) =>
          c.finishes.includes(v.finish) ? v : { ...v, finish: (c.finishes.includes('nonfoil') ? 'nonfoil' : c.finishes[0]) as Finish },
        )
      })
      .catch(() => current && setError("That card didn't load. Try again."))
    return () => {
      current = false
    }
  }, [values.scryfallId])

  const set = (change: Partial<CopyValues>) => setValues((v) => ({ ...v, ...change }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      await onSubmit(values)
    } catch (e) {
      if (e instanceof ApiError) {
        setFieldErrors(e.fieldErrors)
        setError(e.message)
      } else setError("Deckino didn't respond. Try again.")
      setSaving(false)
    }
  }

  const printings = card?.printings.map((p) => ({
    value: p.id,
    label: printingLabel(p) + (p.lang !== 'en' ? `, ${p.lang.toUpperCase()}` : ''),
  }))

  return (
    <Modal opened onClose={onClose} title={title} centered>
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          {error && <Alert color="red" role="alert">{error}</Alert>}
          <Select
            label="Printing"
            data={printings ?? []}
            value={values.scryfallId}
            searchable
            allowDeselect={false}
            disabled={!card}
            error={fieldErrors.scryfallId}
            onChange={(id) => id && set({ scryfallId: id })}
          />
          <Group grow>
            <Select
              label="Finish"
              data={(card?.finishes ?? [values.finish]).map((f) => ({ value: f, label: finishLabels[f as Finish] }))}
              value={values.finish}
              allowDeselect={false}
              error={fieldErrors.finish}
              onChange={(f) => f && set({ finish: f as Finish })}
            />
            <Select
              label="Condition"
              data={conditions}
              value={values.condition}
              allowDeselect={false}
              error={fieldErrors.condition}
              onChange={(c) => c && set({ condition: c })}
            />
          </Group>
          <Group grow>
            <Select
              label="Language"
              data={languages}
              value={values.language}
              allowDeselect={false}
              searchable
              error={fieldErrors.language}
              onChange={(l) => l && set({ language: l })}
            />
            {withCopies && (
              <NumberInput
                label="Copies"
                min={1}
                max={100}
                clampBehavior="strict"
                allowDecimal={false}
                allowNegative={false}
                value={values.copies}
                error={fieldErrors.copies}
                onChange={(n) => typeof n === 'number' && set({ copies: n })}
              />
            )}
          </Group>
          <Textarea
            label="Notes"
            description="Only you see notes."
            maxLength={500}
            autosize
            minRows={2}
            value={values.notes}
            error={fieldErrors.notes}
            onChange={(e) => set({ notes: e.currentTarget.value })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" loading={saving} disabled={!card}>
              {submitLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}
