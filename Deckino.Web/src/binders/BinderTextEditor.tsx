import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core'
import { useState } from 'react'
import { ApiError, sendJson } from '../api'
import { showToast } from '../components/toast'
import { cardLine, type Finish } from '../decks/deck'
import type { BinderCard, BinderDetail, Condition } from './binder'
import classes from '../import/ImportPage.module.css'

type Problem = { line: number; text: string; problem: string }
type NewCopy = { scryfallId: string; finish: Finish; condition: Condition; language: string; notes: string | null; printingConfirmed: boolean }

const keyOf = (scryfallId: string, finish: Finish) => `${scryfallId}|${finish}`

// Copies alike as the API takes them back, at most 100 a line.
function batch(copies: NewCopy[]) {
  const alike = new Map<string, { card: NewCopy; count: number }>()
  for (const c of copies) {
    const key = JSON.stringify(c)
    alike.set(key, { card: c, count: (alike.get(key)?.count ?? 0) + 1 })
  }
  return [...alike.values()].flatMap(({ card, count }) =>
    Array.from({ length: Math.ceil(count / 100) }, (_, i) => ({ card, copies: Math.min(100, count - i * 100) })),
  )
}

const copyOf = ({ scryfallId, finish, condition, language, notes, printingConfirmed }: BinderCard): NewCopy => ({
  scryfallId,
  finish,
  condition,
  language,
  notes: notes ?? null,
  printingConfirmed,
})

// The whole binder as a list, one line per printing and finish, as the deck page's Text view: change counts, delete
// lines or paste cards in, then apply. Fewer copies take out the newest ones; more copies go in like the ones already
// there, or as the condition and language new cards start as. Each copy's condition, language and notes stay.
export function BinderTextEditor({
  binder,
  condition,
  language,
  run,
}: {
  binder: BinderDetail
  condition: Condition
  language: string
  run: (action: () => Promise<BinderDetail>) => Promise<boolean>
}) {
  const have = new Map<string, BinderCard[]>()
  for (const c of binder.cards) {
    const key = keyOf(c.scryfallId, c.finish)
    have.set(key, [...(have.get(key) ?? []), c])
  }
  const current = [...have.values()]
    .sort((a, b) => a[0].card.name.localeCompare(b[0].card.name))
    .map((copies) => cardLine(copies.length, copies[0].finish, copies[0].card))
    .join('\n')
  // null until the user types, so the box follows the binder (cards added above show up), and again after Apply.
  const [edited, setText] = useState<string | null>(null)
  const text = edited ?? current
  const changed = text !== current
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [notes, setNotes] = useState<Problem[]>([])
  const url = `/api/binders/${binder.id}` as const

  async function apply() {
    setBusy(true)
    setError(null)
    setProblems([])
    setNotes([])
    try {
      const lines = text.trim() ? (await sendJson('POST', '/api/import/deck', { text })).lines : []
      const unmatched = lines.filter((l) => !l.card)
      if (unmatched.length) return setProblems(unmatched.map((l) => ({ line: l.line, text: l.text, problem: l.problem ?? '' })))

      const want = new Map<string, number>()
      for (const l of lines) {
        const key = keyOf(l.card!.id, l.finish)
        want.set(key, (want.get(key) ?? 0) + Math.max(0, l.quantity))
      }
      const removed = [...have].flatMap(([key, copies]) => copies.slice(want.get(key) ?? 0))
      const adding = [...want].flatMap(([key, count]) => {
        const copies = have.get(key) ?? []
        const [scryfallId, finish] = key.split('|') as [string, Finish]
        const like = copies[0] ? copyOf(copies[0]) : { scryfallId, finish, condition, language, notes: null, printingConfirmed: true }
        return Array.from({ length: Math.max(0, count - copies.length) }, () => like)
      })
      if (removed.length === 0 && adding.length === 0) return setText(null)

      let added: string[] = []
      // Adds first: if they fail (the binder is full), nothing was taken out, so no copies are lost without an Undo.
      const ok = await run(async () => {
        let latest = binder
        if (adding.length) {
          const result = await sendJson('POST', `${url}/cards/batch`, { cards: batch(adding) })
          added = result.added
          latest = result.binder
        }
        if (removed.length) latest = await sendJson('POST', `${url}/cards/remove`, { cardIds: removed.map((c) => c.id) })
        return latest
      })
      if (!ok) return
      setText(null)
      setNotes(lines.filter((l) => l.note && l.quantity > 0).map((l) => ({ line: l.line, text: l.text, problem: l.note! })))
      showToast({
        message: 'Binder updated from the list',
        // The removed copies come back as they were (with new ids); the added ones go again.
        undo: () =>
          void run(async () => {
            let latest = binder
            if (removed.length) latest = (await sendJson('POST', `${url}/cards/batch`, { cards: batch(removed.map(copyOf)) })).binder
            if (added.length) latest = await sendJson('POST', `${url}/cards/remove`, { cardIds: added })
            return latest
          }),
      })
    } catch (e) {
      setError(e instanceof ApiError ? (e.fieldErrors.text ?? e.message) : "Deckino didn't respond. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const issues = (title: string, color: string, list: Problem[]) =>
    list.length > 0 && (
      <Alert color={color} role="alert" title={title}>
        <Stack gap={4}>
          {list.map((p) => (
            <Text key={p.line} size="sm">
              Line {p.line}, <span className={classes.source}>{p.text}</span>: {p.problem}
            </Text>
          ))}
        </Stack>
      </Alert>
    )

  return (
    <Stack gap="md" mb="xl" aria-label="Binder as text" component="section">
      <Textarea
        label="Card list"
        description='One card per line, like "4 Lightning Bolt" or "1 Sol Ring (C21) 263 *F*". Each card keeps its condition, language and notes; new ones go in like the copies already here.'
        placeholder={'4 Lightning Bolt\n1 Sol Ring (C21) 263 *F*\n…'}
        autosize
        minRows={12}
        maxRows={40}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        classNames={{ input: classes.source }}
      />
      {error && <Alert color="danger" role="alert">{error}</Alert>}
      {issues("These lines didn't match a card, so nothing changed. Fix or delete them.", 'danger', problems)}
      {issues('Applied, with changes', 'warning', notes)}
      <Group justify="flex-end">
        <Button variant="default" disabled={!changed || busy} onClick={() => setText(null)}>
          Discard changes
        </Button>
        <Button variant="gradient" loading={busy} disabled={!changed} onClick={apply}>
          Apply changes
        </Button>
      </Group>
    </Stack>
  )
}
