import { Alert, Badge, Container, Group, HoverCard, SegmentedControl, Skeleton, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, getJson } from '../api'
import { useAuth } from '../account/auth'
import { printingLabel } from '../cards/api'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { ManaSymbols } from '../components/ManaSymbols'
import {
  countCards,
  deckLook,
  entryKey,
  entryPrice,
  finishLabels,
  formatLabel,
  groupByType,
  type DeckEntry,
  type PublicDeck,
  type SectionName,
} from './deck'
import { LegalityAlert } from './DeckPage'
import classes from './DeckPage.module.css'

const sectionLabels: Record<SectionName, string> = { commander: 'Commander', mainboard: 'Mainboard', sideboard: 'Sideboard' }

// A public deck, for anyone with the link or from search: read-only, with value and legality.
export default function PublicDeckPage() {
  const { id } = useParams()
  const { account } = useAuth()
  // undefined while loading; null when it doesn't exist or isn't public; 'failed' when the API didn't answer.
  const [found, setFound] = useState<PublicDeck | null | 'failed'>()
  const [currency, setCurrency] = useCurrency()
  const [view, setView] = useState<'list' | 'gallery'>('list')

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
            {deck.sideboard.length > 0 && ` + ${countCards(deck.sideboard)} sideboard`}
          </span>
          <span data-testid="deck-value">≈ {formatPrice(value, currency)}</span>
        </Group>
      </ArtHeader>

      <Container size="lg">
        {isOwner && (
          <Text size="sm" c="dimmed" mb="md">
            This is your deck as others see it. <Link to={`/decks/${deck.id}`}>Edit it</Link>.
          </Text>
        )}
        {deck.format !== 'casual' && <LegalityAlert format={deck.format} warnings={legality} />}

        <Group justify="flex-end" gap="sm" mb="md">
          <SegmentedControl
            aria-label="View"
            size="xs"
            value={view}
            onChange={(v) => setView(v as 'list' | 'gallery')}
            data={[
              { label: 'List', value: 'list' },
              { label: 'Gallery', value: 'gallery' },
            ]}
          />
          <CurrencyToggle currency={currency} onChange={setCurrency} />
        </Group>

        {sections.map((name) => {
          const groups = name === 'commander' ? [{ label: '', entries: deck[name] }] : groupByType(deck[name])
          return (
            <section key={name} className={classes.section} aria-label={sectionLabels[name]}>
              <Title order={2} className={classes.sectionTitle}>
                {sectionLabels[name]} <span className={classes.count}>{countCards(deck[name])}</span>
              </Title>
              {groups.map((group) => (
                <div key={group.label} className={classes.group}>
                  {group.label && (
                    <Title order={3} className={classes.groupTitle}>
                      {group.label} <span className={classes.count}>{countCards(group.entries)}</span>
                    </Title>
                  )}
                  {view === 'list' ? (
                    <ul className={classes.rows}>
                      {group.entries.map((entry) => (
                        <ReadOnlyRow key={entryKey(entry)} entry={entry} price={formatPrice(entryPrice(entry, currency), currency)} />
                      ))}
                    </ul>
                  ) : (
                    <ul className={classes.gallery}>
                      {group.entries.map((entry) => (
                        <li key={entryKey(entry)} className={classes.galleryCard}>
                          <CardImage src={entry.card.image} alt={entry.card.name} foil={entry.finish !== 'nonfoil'} lazy />
                          {entry.quantity > 1 && <span className={classes.galleryQuantity}>{entry.quantity}×</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )
        })}
      </Container>
    </>
  )
}

function ReadOnlyRow({ entry, price }: { entry: DeckEntry; price: string }) {
  const { card } = entry
  return (
    <li className={classes.row} aria-label={card.name}>
      <span className={classes.quantity}>{entry.quantity}×</span>
      <HoverCard position="right" openDelay={150} disabled={!card.image}>
        <HoverCard.Target>
          <span className={classes.name}>
            <Link to={`/cards/${card.id}`} className={classes.cardName}>
              {card.name}
            </Link>
            {entry.finish !== 'nonfoil' && (
              <Badge size="xs" variant="gradient">
                {finishLabels[entry.finish]}
              </Badge>
            )}
          </span>
        </HoverCard.Target>
        <HoverCard.Dropdown p={0} className={classes.preview}>
          <CardImage src={card.image} alt={card.name} foil={entry.finish !== 'nonfoil'} />
        </HoverCard.Dropdown>
      </HoverCard>
      <span className={classes.mana}>
        <ManaSymbols text={card.manaCost} />
      </span>
      <div className={classes.controls}>
        <Text size="xs" c="dimmed">
          {printingLabel(card)}
        </Text>
        <span className={classes.price}>{price}</span>
      </div>
    </li>
  )
}
