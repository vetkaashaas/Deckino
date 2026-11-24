import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core'
import { useState } from 'react'
import { ApiError, sendJson } from '../api'
import { showToast } from '../components/toast'
import { deckText, putEntry, type DeckSections, type SectionName } from './deck'
import classes from '../import/ImportPage.module.css'

type Deck = { format: string } & DeckSections
type Problem = { line: number; text: string; problem: string }

// The whole deck as an editable decklist: change counts, delete lines, or paste cards in, then apply. The text is
// matched by the import preview (POST /api/import/deck), so anything the importer reads works here too. A line
// with "0" or no line at all takes the card out.
export function DeckTextEditor({ deck, onApply }: { deck: Deck; onApply: (sections: DeckSections) => void }) {
  const current = deckText(deck)
  // null until the user types: the box follows the deck (cards added from the search show up), and goes back to
  // following it after Apply or Discard.
  const [edited, setText] = useState<string | null>(null)
  const text = edited ?? current
  const changed = text !== current
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [notes, setNotes] = useState<Problem[]>([])

  async function apply() {
    setBusy(true)
    setError(null)
    setProblems([])
    setNotes([])
    try {
      const lines = text.trim() ? (await sendJson('POST', '/api/import/deck', { text })).lines : []
      const unmatched = lines.filter((l) => !l.card)
      if (unmatched.length) return setProblems(unmatched.map((l) => ({ line: l.line, text: l.text, problem: l.problem ?? '' })))
      const sections: DeckSections = { commander: [], mainboard: [], sideboard: [] }
      for (const l of lines) {
        if (l.quantity < 1) continue
        const section = (l.section in sections ? l.section : 'mainboard') as SectionName
        sections[section] = putEntry(sections[section], { scryfallId: l.card!.id, quantity: l.quantity, finish: l.finish, card: l.card! })
      }
      const before = { commander: deck.commander, mainboard: deck.mainboard, sideboard: deck.sideboard }
      onApply(sections)
      setText(null)
      setNotes(lines.filter((l) => l.note && l.quantity > 0).map((l) => ({ line: l.line, text: l.text, problem: l.note! })))
      showToast({ message: 'Deck updated from the list', undo: () => onApply(before) })
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
    <Stack gap="md" mb="xl" aria-label="Deck as text" component="section">
      <Textarea
        label="Decklist"
        description='One card per line, like "4 Lightning Bolt" or "1 Sol Ring (C21) 263 *F*". Headers Commander, Deck and Sideboard sort the cards.'
        placeholder={"Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n4 Lightning Bolt\n…"}
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
