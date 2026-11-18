import { Alert, Button, Container, Group, List, Select, Stack, Text, Textarea } from '@mantine/core'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { ArtHeader } from '../components/ArtHeader'
import { Icon } from '../components/Icon'
import { PageTitle } from '../components/PageTitle'
import { countCards, formats, putEntry, type DeckEntry } from '../decks/deck'
import type * as Api from '../generated'
import { canPlaytest, type PlayDeck } from './engine'
import { PlaytestTable, usePlaytest } from './Playtest'

type ImportLine = Api.ImportLine

const listKey = 'deckino.playtestList'

// The pasted list and the deck it resolved to, kept for this tab so a refresh reopens the same playtest.
interface Kept {
  text: string
  format: string | null
  deck: PlayDeck | null
  unmatched: string[]
}

function kept(): Kept {
  const empty: Kept = { text: '', format: null, deck: null, unmatched: [] }
  try {
    return { ...empty, ...JSON.parse(sessionStorage.getItem(listKey) ?? '{}') }
  } catch {
    return empty
  }
}

function keep(value: Kept) {
  try {
    sessionStorage.setItem(listKey, JSON.stringify(value))
  } catch {
    // No storage: a refresh starts over.
  }
}

// A Commander list says so, or is about a hundred cards; anything else plays as casual (20 life).
const guessFormat = (deck: Omit<PlayDeck, 'format' | 'name'>) =>
  deck.commander.length > 0 || countCards(deck.mainboard) >= 98 ? 'commander' : 'casual'

// Lines to deck entries: the same printing and finish merge, as in a saved deck.
function toDeck(lines: ImportLine[]) {
  const sections: Record<'commander' | 'mainboard' | 'sideboard', DeckEntry[]> = { commander: [], mainboard: [], sideboard: [] }
  for (const line of lines) {
    if (!line.card || line.quantity < 1) continue
    const section = line.section === 'commander' || line.section === 'sideboard' ? line.section : 'mainboard'
    sections[section] = putEntry(sections[section], { scryfallId: line.card.id, quantity: Math.min(line.quantity, 99), finish: line.finish, card: line.card })
  }
  return sections
}

// Playtest a pasted decklist without saving it: any list Arena, MTGO, Moxfield, Archidekt or TappedOut exports.
export default function PlaytestPage() {
  const { account } = useAuth()
  const navigate = useNavigate()
  const playtest = usePlaytest()
  const [state, setState] = useState(kept)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (change: Partial<Kept>) =>
    setState((s) => {
      const next = { ...s, ...change }
      keep(next)
      return next
    })

  async function play() {
    setBusy(true)
    setError(null)
    try {
      const { lines } = await sendJson('POST', '/api/import/deck', { text: state.text })
      const sections = toDeck(lines)
      const deck: PlayDeck = { name: 'Pasted list', format: state.format ?? guessFormat(sections), ...sections }
      const unmatched = lines.filter((l) => !l.card && l.problem).map((l) => `${l.text.trim()}: ${l.problem}`)
      update({ deck, unmatched })
      if (canPlaytest(deck)) playtest.open()
      else setError(`The list needs at least 7 cards Deckino recognises outside the commander and sideboard. It has ${countCards(deck.mainboard)}.`)
    } catch (e) {
      setError(e instanceof ApiError ? (e.fieldErrors.text ?? e.message) : "Deckino didn't respond. Try again.")
    } finally {
      setBusy(false)
    }
  }

  // The format picked now, or the guess again for "Work it out" (the one baked in at Playtest may have been a pick).
  const deck = state.deck && { ...state.deck, format: state.format ?? guessFormat(state.deck) }

  return (
    <>
      <ArtHeader>
        <PageTitle>Playtest a list</PageTitle>
        <Text c="dimmed" mt="xs">
          Paste a decklist and goldfish it: draw, mulligan and play turns to see how it runs. Nothing is saved.
        </Text>
      </ArtHeader>

      <Container size="md">
        <Stack gap="md">
          <Textarea
            label="Decklist"
            description="Exports from Arena, MTGO, Moxfield, Archidekt, TappedOut or ManaBox all work."
            placeholder={'1 Atraxa, Praetors\' Voice\n1 Sol Ring\n35 Forest\n…'}
            autosize
            readOnly={busy} // a change mid-request would be overwritten by the old list's deck
            minRows={10}
            maxRows={22}
            value={state.text}
            onChange={(e) => update({ text: e.currentTarget.value, deck: null, unmatched: [] })}
          />
          <Group justify="space-between" align="flex-end">
            <Select
              label="Format"
              w={200}
              data={[{ value: '', label: 'Work it out' }, ...formats]}
              value={state.format ?? ''}
              allowDeselect={false}
              onChange={(f) => update({ format: f || null })}
            />
            <Group gap="sm">
              {account && state.text.trim() && (
                <Button variant="default" leftSection={<Icon name="library_add" size={18} />} onClick={() => navigate('/decks/import', { state: { text: state.text } })}>
                  Save as a deck
                </Button>
              )}
              <Button variant="gradient" leftSection={<Icon name="playing_cards" size={18} />} loading={busy} disabled={!state.text.trim()} onClick={play}>
                Playtest
              </Button>
            </Group>
          </Group>

          {error && (
            <Alert color="danger" role="alert">
              {error}
            </Alert>
          )}

          {state.unmatched.length > 0 && (
            <Alert color="warning" title={`${state.unmatched.length} ${state.unmatched.length === 1 ? 'line was' : 'lines were'} left out`} role="status">
              <List size="sm">
                {state.unmatched.map((line, i) => (
                  <List.Item key={i}>{line}</List.Item>
                ))}
              </List>
            </Alert>
          )}
        </Stack>
      </Container>

      {deck && canPlaytest(deck) && playtest.isOpen && <PlaytestTable deck={deck} storageKey="list" seed={playtest.seed} onClose={playtest.close} />}
    </>
  )
}
