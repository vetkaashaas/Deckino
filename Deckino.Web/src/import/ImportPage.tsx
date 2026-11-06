import { Alert, Anchor, Badge, Button, Container, Group, Select, Stack, Text, TextInput, Textarea, Title } from '@mantine/core'
import { useState, type DragEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { conditions, languageLabel } from '../binders/binder'
import { printingLabel } from '../cards/api'
import { CardPicker } from '../cards/CardPicker'
import { ArtHeader } from '../components/ArtHeader'
import { CardPreview } from '../components/CardPreview'
import { sticky, useStuck } from '../components/sticky'
import { defaultFinish, entryKey, finishLabels, formats, toDeckCard, type DeckEntry, type SectionName } from '../decks/deck'
import type * as Api from '../generated'
import classes from './ImportPage.module.css'
import { Icon } from '../components/Icon'

// POST /api/import/deck and /api/import/binder: each line of the file, matched to a printing or not.
type ImportLine = Api.ImportLine

type Kind = 'deck' | 'binder'

const copy = {
  deck: {
    title: 'Import a deck',
    intro: 'Paste a decklist, or drop the file your app exported.',
    apps: 'Arena · MTGO · Moxfield · Archidekt · TappedOut',
    placeholder: 'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n4 Lightning Bolt (2X2) 117 *F*\n…',
    accept: '.txt,.dek,.dck,text/plain',
    back: '/decks',
  },
  binder: {
    title: 'Import a binder',
    intro: 'Paste a CSV, or drop the file your app exported.',
    apps: 'ManaBox · Deckbox · Deckino',
    placeholder: 'Name,Set code,Collector number,Foil,Quantity,Condition,Language\nLightning Bolt,lea,161,normal,2,near_mint,en',
    accept: '.csv,text/csv',
    back: '/collection',
  },
}

const sectionLabels: Record<string, string> = { commander: 'Commander', mainboard: 'Mainboard', sideboard: 'Sideboard' }

const isLegendary = (line: ImportLine) => line.card?.typeLine?.includes('Legendary') === true

export default function ImportPage({ kind }: { kind: Kind }) {
  const { account } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const text = copy[kind]
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [format, setFormat] = useState('commander')
  const [source, setSource] = useState('')
  const [lines, setLines] = useState<ImportLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The commander, when the list doesn't mark one (Moxfield's copy puts it first, unmarked): a line number.
  const [commanderLine, setCommanderLine] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [bar, stuck] = useStuck<HTMLDivElement>()

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  async function review() {
    // A deck always has a name; asked here, as the review can't change it.
    if (kind === 'deck' && !name.trim()) return setNameError('Give the deck a name.')
    setNameError(null)
    setError(null)
    setBusy(true)
    try {
      const parsed = (await sendJson('POST', `/api/import/${kind}`, { text: source })).lines
      setLines(parsed)
      // No commander marked: Moxfield puts the commander first and sorts the rest by name, so a legendary first
      // line that's out of alphabetical order is suggested. An alphabetical list suggests nothing.
      const [first, second] = parsed.filter((l) => l.card)
      const unmarked = format === 'commander' && !parsed.some((l) => l.section === 'commander')
      const outOfOrder = first && second && first.card!.name.localeCompare(second.card!.name) > 0
      setCommanderLine(unmarked && outOfOrder && isLegendary(first) ? first.line : null)
    } catch (e) {
      setError(e instanceof ApiError ? (e.fieldErrors.text ?? e.message) : "Deckino didn't respond. Try again.")
    } finally {
      setBusy(false)
    }
  }

  // A file, chosen or dropped: its text goes in the box, and its name names the deck or binder when that's empty.
  function read(file: File | null | undefined) {
    if (!file) return
    file.text().then((content) => {
      setSource(content)
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, '').slice(0, 100))
    })
  }
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return
      e.preventDefault()
      setDragging(false)
      read(e.dataTransfer.files[0])
    },
  }

  // Picking a card for a line that didn't match: its default printing, in the line's finish when it has it.
  async function fix(line: ImportLine, scryfallId: string) {
    try {
      const card = toDeckCard(await getJson(`/api/cards/${scryfallId}`))
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
        const add = (section: SectionName, l: ImportLine, quantity: number) => {
          const entry = { scryfallId: l.card!.id, quantity, finish: l.finish, card: l.card! }
          const same = sections[section].find((e) => entryKey(e) === entryKey(entry))
          if (same) same.quantity += quantity
          else sections[section].push(entry)
        }
        for (const l of matched) {
          if (l.line === commanderLine) {
            // A chosen commander is one copy; any others stay where the list put them.
            add('commander', l, 1)
            if (l.quantity > 1) add(ownSection(l), l, l.quantity - 1)
          } else add(sectionOf(l), l, l.quantity)
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
        const deck = await sendJson('POST', '/api/decks', {
          name: name.trim(),
          format,
          cards: { commander: entries(sections.commander), mainboard: entries(sections.mainboard), sideboard: entries(sections.sideboard) },
        })
        navigate(`/decks/${deck.id}`)
      } else {
        const binder = await sendJson('POST', '/api/binders/import', {
          name: name.trim() || 'Imported binder',
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

  // The section the list put a line in, and where it goes (a chosen commander line sends one copy to the commander).
  const ownSection = (l: ImportLine) => (l.section in sectionLabels ? l.section : 'mainboard') as SectionName
  const sectionOf = (l: ImportLine) => (l.line === commanderLine ? 'commander' : ownSection(l))
  const choosingCommander = kind === 'deck' && format === 'commander' && !!lines && !lines.some((l) => l.section === 'commander')
  const matchedLines = lines?.filter((l) => l.card) ?? []
  const unmatchedLines = lines?.filter((l) => !l.card) ?? []
  const unresolved = unmatchedLines.length
  const matchedCount = matchedLines.reduce((sum, l) => sum + l.quantity, 0)

  return (
    <>
      <ArtHeader>
        <Anchor component={Link} to={text.back} size="sm" c="dark.1">
          {kind === 'deck' ? 'Your decks' : 'Collection'}
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
          <Alert color="danger" role="alert" mb="lg" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {!lines ? (
          // The form, and beside it (under it on a phone) a place to drop the file; dropping on the form works too.
          <div className={classes.start} data-dragging={dragging || undefined} {...drop}>
          <Stack gap="md" className={classes.form}>
            <Group align="flex-end" gap="md">
              <TextInput
                label={kind === 'deck' ? 'Deck name' : 'Binder name'}
                placeholder={kind === 'deck' ? undefined : 'Imported binder'}
                maxLength={100}
                value={name}
                error={nameError}
                onChange={(e) => {
                  setName(e.currentTarget.value)
                  setNameError(null)
                }}
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
            <Group justify="flex-end">
              <Button variant="gradient" loading={busy} disabled={!source.trim()} onClick={review}>
                Review import
              </Button>
            </Group>
          </Stack>
          <label className={classes.drop}>
            <input type="file" accept={text.accept} className={classes.fileInput} onChange={(e) => read(e.currentTarget.files?.[0])} />
            <Icon name="upload_file" size={32} className={classes.dropIcon} />
            <span className={classes.dropWords}>
              <Text fw={600}>{dragging ? 'Drop it here' : 'Drop your file here'}</Text>
              <Text size="sm" c="dimmed">
                or
              </Text>
            </span>
            <span className={classes.choose}>Choose a file</span>
            <Text size="xs" c="dimmed" ta="center" mt="sm">
              {text.apps}
            </Text>
          </label>
          </div>
        ) : (
          <section aria-label="Import review">
            {/* How many are ready and what's left to do, with Create, on screen while the list scrolls. */}
            <div ref={bar} className={`${sticky} ${classes.bar}`} data-stuck={stuck || undefined}>
              <Text role="status" className={classes.status}>
                {matchedCount} {matchedCount === 1 ? 'card' : 'cards'} ready
                {unresolved > 0 && ` · ${unresolved} ${unresolved === 1 ? 'line needs' : 'lines need'} a card or dropping`}
              </Text>
              <Group gap="sm">
                {unresolved > 0 && (
                  <Button variant="subtle" color="gray" onClick={() => setLines((all) => all?.filter((l) => l.card) ?? null)}>
                    Drop unmatched lines
                  </Button>
                )}
                <Button variant="default" onClick={() => setLines(null)}>
                  Back
                </Button>
                <Button variant="gradient" loading={busy} disabled={unresolved > 0 || matchedCount === 0} onClick={create}>
                  Create {kind}
                </Button>
              </Group>
            </div>
            {choosingCommander && (
              <Select
                label="Commander"
                description="This list doesn't mark its commander. Choose it here, or later from a card's menu."
                placeholder="No commander"
                data={lines
                  .filter(isLegendary)
                  .map((l) => ({ value: String(l.line), label: l.card!.name }))}
                value={commanderLine === null ? null : String(commanderLine)}
                onChange={(v) => setCommanderLine(v === null ? null : Number(v))}
                clearable
                searchable
                maw={420}
                mb="md"
              />
            )}
            {/* What needs the user first, then the cards that are ready. */}
            {[
              { title: 'Needs you', list: unmatchedLines, count: unmatchedLines.length },
              { title: 'Ready', list: matchedLines, count: matchedCount },
            ].map(({ title, list, count }) => list.length > 0 && (
            <div key={title} className={classes.group}>
            {unmatchedLines.length > 0 && (
              <Title order={2} size="h4" className={classes.groupTitle}>
                {title} <span className={classes.groupCount}>{count}</span>
              </Title>
            )}
            <ul className={classes.lines}>
              {list.map((line) => (
                <li key={line.line} className={classes.line} data-unresolved={line.card ? undefined : true} aria-label={`Line ${line.line}`}>
                  {line.card ? (
                    <>
                      <span className={classes.quantity}>{line.quantity}×</span>
                      <img className={classes.thumb} src={line.card.smallImage ?? line.card.image ?? undefined} alt="" loading="lazy" data-preview />
                      <CardPreview src={line.card.image} name={line.card.name} foil={line.finish !== 'nonfoil'} />
                      <div className={classes.what}>
                        <Text fw={500} className={classes.fit} data-preview>
                          {line.card.name}
                        </Text>
                        <Text size="xs" c="dimmed" className={classes.fit} data-preview>
                          {printingLabel(line.card)}
                        </Text>
                        {line.note && (
                          <Text size="xs" c="warning" className={classes.note}>
                            <Icon name="warning" size={14} /> {line.note}
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
                          line.line === commanderLine && line.quantity > 1 ? (
                            <>
                              <Badge size="sm" variant="default">
                                1 Commander
                              </Badge>
                              <Badge size="sm" variant="default">
                                {line.quantity - 1} {sectionLabels[ownSection(line)]}
                              </Badge>
                            </>
                          ) : (
                            <Badge size="sm" variant="default">
                              {sectionLabels[sectionOf(line)]}
                            </Badge>
                          )
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
                        <Text size="xs" c="warning">
                          Line {line.line}: {line.problem}
                        </Text>
                        <div className={classes.fix}>
                          <CardPicker label={`Card for line ${line.line}`} placeholder="Find the card" quantities={false} onPick={(id) => fix(line, id)} />
                        </div>
                      </div>
                      <Button
                        variant="subtle"
                        color="gray"
                        leftSection={<Icon name="delete" size={16} />}
                        onClick={() => setLines((all) => all?.filter((l) => l !== line) ?? null)}
                      >
                        Drop
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            </div>
            ))}
          </section>
        )}
      </Container>
    </>
  )
}
