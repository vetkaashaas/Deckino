import { Alert, Anchor, Badge, Button, Container, FileButton, Group, Select, Stack, Text, TextInput, Textarea, Title } from '@mantine/core'
import { IconAlertTriangle, IconFileUpload, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { conditions, languageLabel } from '../binders/binder'
import { printingLabel, type CardDetail } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { ArtHeader } from '../components/ArtHeader'
import { defaultFinish, entryKey, finishLabels, formats, toDeckCard, type DeckCard, type DeckEntry, type Finish, type SectionName } from '../decks/deck'
import classes from './ImportPage.module.css'

// POST /api/import/deck and /api/import/binder: each line of the file, matched to a printing or not.
interface ImportLine {
  line: number
  text: string
  section: string
  quantity: number
  finish: Finish
  condition: string | null
  language: string | null
  notes: string | null
  card: DeckCard | null
  problem: string | null
  note: string | null
}

type Kind = 'deck' | 'binder'

const copy = {
  deck: {
    title: 'Import a deck',
    intro: 'Paste a decklist, or choose a text file exported from Arena, MTGO, Moxfield or Archidekt.',
    placeholder: 'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n4 Lightning Bolt (2X2) 117 *F*\n…',
    accept: '.txt,.dek,.dck,text/plain',
    back: '/decks',
  },
  binder: {
    title: 'Import a binder',
    intro: 'Choose a CSV exported from ManaBox, Deckbox or Deckino, or paste its contents.',
    placeholder: 'Name,Set code,Collector number,Foil,Quantity,Condition,Language\nLightning Bolt,lea,161,normal,2,near_mint,en',
    accept: '.csv,text/csv',
    back: '/binders',
  },
}

const sectionLabels: Record<string, string> = { commander: 'Commander', mainboard: 'Mainboard', sideboard: 'Sideboard' }

export default function ImportPage({ kind }: { kind: Kind }) {
  const { account } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const text = copy[kind]
  const [name, setName] = useState('')
  const [format, setFormat] = useState('commander')
  const [source, setSource] = useState('')
  const [lines, setLines] = useState<ImportLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  async function review() {
    setError(null)
    if (!name.trim()) return setError(`Give the ${kind} a name.`)
    setBusy(true)
    try {
      setLines((await sendJson<{ lines: ImportLine[] }>('POST', `/api/import/${kind}`, { text: source })).lines)
    } catch (e) {
      setError(e instanceof ApiError ? (e.fieldErrors.text ?? e.message) : "Deckino didn't respond. Try again.")
    } finally {
      setBusy(false)
    }
  }

  // Picking a card for a line that didn't match: its default printing, in the line's finish when it has it.
  async function fix(line: ImportLine, scryfallId: string) {
    try {
      const card = toDeckCard(await getJson<CardDetail>(`/api/cards/${scryfallId}`))
      const finish = card.finishes.includes(line.finish) ? line.finish : defaultFinish(card)
      setLines((all) => all?.map((l) => (l === line ? { ...l, card, finish, problem: null, note: null } : l)) ?? null)
    } catch {
      setError("That card didn't load. Try again.")
    }
  }

  async function create() {
    if (!lines) return
    setBusy(true)
    setError(null)
    const matched = lines.filter((l) => l.card)
    try {
      if (kind === 'deck') {
        // Lines for the same printing and finish in a section become one entry, quantities added up.
        const sections: Record<SectionName, DeckEntry[]> = { commander: [], mainboard: [], sideboard: [] }
        for (const l of matched) {
          const section = (l.section in sections ? l.section : 'mainboard') as SectionName
          const entry = { scryfallId: l.card!.id, quantity: l.quantity, finish: l.finish, card: l.card! }
          const same = sections[section].find((e) => entryKey(e) === entryKey(entry))
          if (same) same.quantity += l.quantity
          else sections[section].push(entry)
        }
        const tooMany = Object.values(sections).flat().filter((e) => e.quantity > 99)
        if (tooMany.length) {
          setError(
            `A deck holds at most 99 copies of a printing in one finish: ${tooMany.map((e) => `${e.card.name} has ${e.quantity}`).join(', ')}. ` +
              'Split them across printings or finishes in the file, or lower the count.',
          )
          setBusy(false)
          return
        }
        const entries = (list: DeckEntry[]) => list.map(({ scryfallId, quantity, finish }) => ({ scryfallId, quantity, finish }))
        const deck = await sendJson<{ id: string }>('POST', '/api/decks', {
          name,
          format,
          cards: { commander: entries(sections.commander), mainboard: entries(sections.mainboard), sideboard: entries(sections.sideboard) },
        })
        navigate(`/decks/${deck.id}`)
      } else {
        const binder = await sendJson<{ id: string }>('POST', '/api/binders/import', {
          name,
          cards: matched.map((l) => ({
            card: { scryfallId: l.card!.id, finish: l.finish, condition: l.condition ?? 'NM', language: l.language ?? 'en', notes: l.notes },
            copies: l.quantity,
          })),
        })
        navigate(`/binders/${binder.id}`)
      }
    } catch (e) {
      if (e instanceof ApiError) {
        const { cards, name: nameError, ...rest } = e.fieldErrors
        setError(cards ?? nameError ?? Object.values(rest)[0] ?? e.message)
      } else setError("Deckino didn't respond. Try again.")
      setBusy(false)
    }
  }

  const unresolved = lines?.filter((l) => !l.card).length ?? 0
  const matchedCount = lines?.filter((l) => l.card).reduce((sum, l) => sum + l.quantity, 0) ?? 0

  return (
    <>
      <ArtHeader>
        <Anchor component={Link} to={text.back} size="sm" c="dark.1">
          {kind === 'deck' ? 'Your decks' : 'Your binders'}
        </Anchor>
        <Title order={1} mt={6}>
          {text.title}
        </Title>
        <Text c="dimmed" mt="xs">
          {text.intro}
        </Text>
      </ArtHeader>

      <Container size="lg">
        {error && (
          <Alert color="red" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {!lines ? (
          <Stack gap="md" maw={720}>
            <Group align="flex-end" gap="md">
              <TextInput
                label={kind === 'deck' ? 'Deck name' : 'Binder name'}
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                style={{ flex: '1 1 240px' }}
              />
              {kind === 'deck' && (
                <Select label="Format" data={formats} value={format} allowDeselect={false} onChange={(f) => f && setFormat(f)} w={170} />
              )}
            </Group>
            <Textarea
              label={kind === 'deck' ? 'Decklist' : 'CSV'}
              placeholder={text.placeholder}
              autosize
              minRows={10}
              maxRows={24}
              value={source}
              onChange={(e) => setSource(e.currentTarget.value)}
              classNames={{ input: classes.source }}
            />
            <Group justify="space-between">
              <FileButton
                accept={text.accept}
                onChange={(file) => {
                  if (!file) return
                  file.text().then((content) => {
                    setSource(content)
                    if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ''))
                  })
                }}
              >
                {(props) => (
                  <Button {...props} variant="default" leftSection={<IconFileUpload size={18} />}>
                    Choose a file
                  </Button>
                )}
              </FileButton>
              <Button variant="gradient" loading={busy} disabled={!source.trim()} onClick={review}>
                Review import
              </Button>
            </Group>
          </Stack>
        ) : (
          <>
            <Group justify="space-between" mb="md" gap="md">
              <Text role="status">
                {matchedCount} {matchedCount === 1 ? 'card' : 'cards'} ready
                {unresolved > 0 && ` · ${unresolved} ${unresolved === 1 ? 'line needs' : 'lines need'} a card or dropping`}
              </Text>
              <Group gap="sm">
                <Button variant="default" onClick={() => setLines(null)}>
                  Back
                </Button>
                <Button variant="gradient" loading={busy} disabled={unresolved > 0 || matchedCount === 0} onClick={create}>
                  Create {kind}
                </Button>
              </Group>
            </Group>
            <ul className={classes.lines} aria-label="Import review">
              {lines.map((line) => (
                <li key={line.line} className={classes.line} data-unresolved={line.card ? undefined : true} aria-label={`Line ${line.line}`}>
                  {line.card ? (
                    <>
                      <span className={classes.quantity}>{line.quantity}×</span>
                      <div className={classes.what}>
                        <Text fw={500}>{line.card.name}</Text>
                        <Text size="xs" c="dimmed">
                          {printingLabel(line.card)}
                        </Text>
                        {line.note && (
                          <Text size="xs" c="yellow.4" className={classes.note}>
                            <IconAlertTriangle size={14} aria-hidden /> {line.note}
                          </Text>
                        )}
                      </div>
                      <Group gap={6} className={classes.badges}>
                        {line.finish !== 'nonfoil' && (
                          <Badge size="sm" variant="gradient">
                            {finishLabels[line.finish]}
                          </Badge>
                        )}
                        {kind === 'deck' ? (
                          <Badge size="sm" variant="default">
                            {sectionLabels[line.section] ?? 'Mainboard'}
                          </Badge>
                        ) : (
                          <>
                            <Badge size="sm" variant="default" title={conditions.find((c) => c.value === line.condition)?.label}>
                              {line.condition ?? 'NM'}
                            </Badge>
                            <Badge size="sm" variant="default">
                              {languageLabel(line.language ?? 'en')}
                            </Badge>
                          </>
                        )}
                      </Group>
                    </>
                  ) : (
                    <>
                      <span className={classes.quantity}>{line.quantity || ''}</span>
                      <div className={classes.what}>
                        <Text fw={500} className={classes.source}>
                          {line.text}
                        </Text>
                        <Text size="xs" c="pink.3">
                          Line {line.line}: {line.problem}
                        </Text>
                        <div className={classes.fix}>
                          <CardPicker label={`Card for line ${line.line}`} placeholder="Find the card" onPick={(id) => fix(line, id)} />
                        </div>
                      </div>
                      <Button
                        variant="subtle"
                        color="gray"
                        leftSection={<IconTrash size={16} />}
                        onClick={() => setLines((all) => all?.filter((l) => l !== line) ?? null)}
                      >
                        Drop
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Container>
    </>
  )
}
