import { Alert, Badge, Button, Container, Group, SegmentedControl, Skeleton, Text, Title } from '@mantine/core'
import { IconCheck, IconClipboard, IconCopyPlus, IconDownload } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { printingLabel } from '../cards/api'
import { ArtHeader } from '../components/ArtHeader'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { ManaSymbols } from '../components/ManaSymbols'
import { countCards, deckLook, entryPrice, formatLabel, sectionLabel, toRequest, type DeckDetail, type PublicDeck } from './deck'
import { CardName, DeckHero, DeckSection, LegalityAlert } from './DeckParts'
import { DeckGallery, GallerySizeControl, useGallerySize } from './DeckGallery'
import { DeckStacks } from './DeckStacks'
import { DeckStats } from './DeckStats'
import classes from './DeckPage.module.css'

// "Copy to my decks": the same cards, as a new private deck of the visitor's own.
function CopyDeck({ deck }: { deck: DeckDetail }) {
  const { account } = useAuth()
  const navigate = useNavigate()
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState(false)
  if (account === undefined) return null
  if (account === null) {
    return (
      <Button component={Link} to={`/login?returnTo=${encodeURIComponent(`/deck/${deck.id}`)}`} variant="gradient" leftSection={<IconCopyPlus size={18} />}>
        Log in to copy this deck
      </Button>
    )
  }
  async function copy() {
    setCopying(true)
    setError(false)
    try {
      const name = `${deck.name} (copy)`.slice(0, 100)
      const created = await sendJson<DeckDetail>('POST', '/api/decks', toRequest({ ...deck, name }))
      navigate(`/decks/${created.id}`)
    } catch {
      setError(true)
      setCopying(false)
    }
  }
  return (
    <>
      <Button variant="gradient" leftSection={<IconCopyPlus size={18} />} loading={copying} onClick={copy}>
        Copy to my decks
      </Button>
      {error && (
        <Text size="sm" c="pink.3" role="alert">
          The deck wasn't copied. Try again.
        </Text>
      )}
    </>
  )
}

// The decklist as text on the clipboard, in the layout Arena, MTGO and the other deck builders read.
function CopyDecklist({ deckId }: { deckId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    const text = fetch(`/api/public/decks/${deckId}/export`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    try {
      // Safari only allows a clipboard write started by the click itself, so the list goes in as a promise for it
      // (ClipboardItem); browsers without it copy once the text has loaded.
      if (typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })])
      } else {
        await navigator.clipboard.writeText(await text)
      }
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      setState('failed')
    }
  }
  return (
    <Button variant="default" leftSection={state === 'copied' ? <IconCheck size={16} /> : <IconClipboard size={16} />} onClick={copy}>
      {state === 'copied' ? 'Decklist copied' : state === 'failed' ? "Couldn't copy: try again" : 'Copy decklist'}
    </Button>
  )
}

// A public deck, for anyone with the link or from search: read-only, with value and legality.
export default function PublicDeckPage() {
  const { id } = useParams()
  const { account } = useAuth()
  // undefined while loading; null when it doesn't exist or isn't public; 'failed' when the API didn't answer.
  const [found, setFound] = useState<PublicDeck | null | 'failed'>()
  const [currency, setCurrency] = useCurrency()
  const [gallerySize, setGallerySize] = useGallerySize()
  const [view, setView] = useState<'list' | 'gallery' | 'stacks'>('gallery')

  useEffect(() => {
    let current = true
    getJson<PublicDeck>(`/api/public/decks/${id}`)
      .then((d) => current && setFound(d))
      .catch((e) => current && setFound(e instanceof ApiError && e.status === 404 ? null : 'failed'))
    return () => {
      current = false
    }
  }, [id])

  if (found === undefined) {
    return (
      <Container size="lg" py="xl" aria-busy="true">
        <Skeleton height={48} width="50%" mb="xl" />
        <Skeleton height={300} />
      </Container>
    )
  }
  if (found === null || found === 'failed') {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" role="alert" title={found === null ? 'Deck not found' : "This deck didn't load"}>
          {found === null
            ? "There's no public deck at this address. Its owner may have made it private."
            : "Deckino didn't respond. Reload the page to try again."}
        </Alert>
      </Container>
    )
  }

  const { deck, owner, legality } = found
  const look = deckLook(deck)
  const all = [...deck.commander, ...deck.mainboard, ...deck.sideboard]
  const value = all.reduce((sum, e) => sum + (entryPrice(e, currency) ?? 0) * e.quantity, 0)
  const cardCount = countCards(deck.commander) + countCards(deck.mainboard)
  const sections = (['commander', 'mainboard', 'sideboard'] as const).filter((s) => deck[s].length > 0)
  const isOwner = account?.username === owner

  return (
    <>
      <ArtHeader art={look.cover}>
        <DeckHero
          card={deck.commander[0]}
          actions={
            <Group gap="sm" justify="flex-end">
              <CopyDecklist deckId={deck.id} />
              <Button component="a" href={`/api/public/decks/${deck.id}/export`} download variant="subtle" color="gray" leftSection={<IconDownload size={16} />}>
                Download
              </Button>
              {!isOwner && <CopyDeck deck={deck} />}
            </Group>
          }
        >
          <Title order={1} className={classes.title}>
            {deck.name}
          </Title>
          <Group gap="md" mt="sm" className={classes.facts}>
            <span>by {owner}</span>
            <Badge variant="light" size="lg">
              {formatLabel(deck.format)}
            </Badge>
            {look.colors.length > 0 && (
              <span className={classes.pips} aria-label={`Colours: ${look.colors.join('')}`}>
                <ManaSymbols text={look.colors.map((c) => `{${c}}`).join('')} />
              </span>
            )}
            <span data-testid="deck-count">
              {cardCount} {cardCount === 1 ? 'card' : 'cards'}
              {deck.sideboard.length > 0 && ` + ${countCards(deck.sideboard)} ${sectionLabel('sideboard', deck.format).toLowerCase()}`}
            </span>
            <span data-testid="deck-value">≈ {formatPrice(value, currency)}</span>
          </Group>
          {deck.format !== 'casual' && (
            <Group mt="md">
              <LegalityAlert format={deck.format} warnings={legality} />
            </Group>
          )}
        </DeckHero>
      </ArtHeader>

      <Container size="lg">
        {isOwner && (
          <Text size="sm" c="dimmed" mb="md">
            This is your deck as others see it. <Link to={`/decks/${deck.id}`}>Edit it</Link>.
          </Text>
        )}

        <DeckStats deck={deck} />

        <div className={classes.toolbar}>
          <span />
          <Group gap="sm">
            <SegmentedControl
              aria-label="View"
              size="xs"
              value={view}
              onChange={(v) => setView(v as 'list' | 'gallery' | 'stacks')}
              data={[
                { label: 'Gallery', value: 'gallery' },
                { label: 'Stacks', value: 'stacks' },
                { label: 'List', value: 'list' },
              ]}
            />
            {view === 'gallery' && <GallerySizeControl size={gallerySize} onChange={setGallerySize} />}
            <CurrencyToggle currency={currency} onChange={setCurrency} />
          </Group>
        </div>

        {sections.map((name) => (
          <DeckSection
            key={name}
            name={name}
            format={deck.format}
            entries={deck[name]}
            stacks={
              view === 'stacks' ? (
                <DeckStacks section={name} entries={deck[name]} />
              ) : view === 'gallery' ? (
                <DeckGallery section={name} entries={deck[name]} currency={currency} size={gallerySize} />
              ) : undefined
            }
            renderRow={(entry) => (
              <>
                <span className={classes.quantityCell}>
                  <span className={classes.single}>{entry.quantity}×</span>
                </span>
                <CardName entry={entry} link />
                <span className={classes.mana}>
                  <ManaSymbols text={entry.card.manaCost} />
                </span>
                <div className={classes.controls}>
                  <Text size="xs" c="dimmed" className={classes.printingText}>
                    {printingLabel(entry.card)}
                  </Text>
                  <span className={classes.price}>{formatPrice(entryPrice(entry, currency), currency)}</span>
                </div>
              </>
            )}
          />
        ))}
      </Container>
    </>
  )
}
