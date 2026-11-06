import { Alert, Anchor, Button, Container, Group, ScrollArea, Skeleton, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArtHeader } from '../components/ArtHeader'
import { QuickAdd } from './QuickAdd'
import { useAuth } from '../account/auth'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { Icon } from '../components/Icon'
import { ManaSymbols } from '../components/ManaSymbols'
import { SetSymbol } from '../components/SetSymbol'
import { getJson } from '../api'
import { type CardDetail, type CardFace } from './api'
import classes from './CardPage.module.css'
import { PriceHistory } from './PriceHistory'
import { PrintingPicker } from './PrintingPicker'

function FaceText({ face, heading }: { face: CardFace; heading: boolean }) {
  const stats = face.loyalty ? `Loyalty ${face.loyalty}` : face.power ? `${face.power}/${face.toughness}` : null
  return (
    <section className={classes.face}>
      {heading && (
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Title order={2} className={classes.faceName}>
            {face.name}
          </Title>
          {face.manaCost && (
            <span className={classes.mana}>
              <ManaSymbols text={face.manaCost} />
            </span>
          )}
        </Group>
      )}
      {face.typeLine && (
        <Text fw={500} c="dimmed">
          {face.typeLine}
        </Text>
      )}
      {face.oracleText && (
        <Text className={classes.oracle}>
          <ManaSymbols text={face.oracleText} />
        </Text>
      )}
      {stats && <Text fw={600}>{stats}</Text>}
      {face.flavorText && (
        <Text c="dimmed" fs="italic" className={classes.oracle}>
          {face.flavorText}
        </Text>
      )}
    </section>
  )
}

export default function CardPage() {
  const { account } = useAuth()
  const { id } = useParams()
  const [card, setCard] = useState<CardDetail | null>()
  const [currency] = useCurrency()
  const [picking, setPicking] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    // A superseded response is ignored rather than aborted: cancelling only saves a few milliseconds of
    // database work, and in development React's double-run of effects would cancel every first load.
    let current = true
    getJson(`/api/cards/${id}`)
      .then((c) => current && setCard(c))
      .catch(() => current && setCard(null))
    return () => {
      current = false
    }
  }, [id])

  if (card === undefined) {
    return (
      <Container size="lg" py="xl" aria-busy="true">
        <Skeleton height={48} width="50%" mb="xl" />
        <Skeleton height={420} width={300} />
      </Container>
    )
  }
  if (card === null) {
    return (
      <Container size="lg" py="xl">
        <Alert color="danger" title="Card not found" role="alert">
          No card has this address. <Anchor component={Link} to="/cards">Search the catalogue</Anchor> instead.
        </Alert>
      </Container>
    )
  }

  const prices =
    currency === 'usd'
      ? [
          ['Normal', card.prices.usd],
          ['Foil', card.prices.usdFoil],
          ['Etched', card.prices.usdEtched],
        ]
      : [
          ['Normal', card.prices.eur],
          ['Foil', card.prices.eurFoil],
        ]
  const shownPrices = prices.filter(([, value]) => value !== null) as [string, number][]
  const singleFace = card.faces.length === 0
  const others = card.printings.length > 1

  return (
    <>
      <ArtHeader art={card.artCrop ?? card.images[0]}>
        <div className={classes.headerText}>
          <Anchor component={Link} to="/cards" size="sm" c="dark.1">
            Cards
          </Anchor>
          <Group gap="md" align="baseline" mt={6} wrap="wrap">
            <Title order={1}>{card.name}</Title>
            {card.manaCost && (
              <span className={classes.headerMana}>
                <ManaSymbols text={card.manaCost} />
              </span>
            )}
          </Group>
          {account && (
            <Group gap="sm" mt="md">
              <QuickAdd cardId={card.id} cardName={card.name} variant="button" />
            </Group>
          )}
        </div>
      </ArtHeader>

      <Container size="lg">
        <div className={classes.layout}>
          <div className={classes.images}>
            {card.images.map((src, i) => (
              <CardImage
                key={src}
                src={src}
                alt={i === 0 ? card.name : `${card.name} (back face)`}
                foil={card.finishes.length === 1 && card.finishes[0] !== 'nonfoil'}
              />
            ))}
            {/* The app's printing button: every printing as its picture, to open another. */}
            {others && (
              <Button variant="default" size="md" leftSection={<Icon name="layers" size={20} />} onClick={() => setPicking(true)}>
                See all {card.printings.length} printings
              </Button>
            )}
          </div>

          <Stack gap="xl" className={classes.info}>
            {/* The rules text, plain under the title as in the app; a card with two faces shows each with its name. */}
            <div>
              {singleFace ? (
                <FaceText face={card} heading={false} />
              ) : (
                card.faces.map((face, i) => <FaceText key={i} face={face} heading />) // reversible cards repeat face names
              )}
            </div>

            {/* The app's printing panel: which printing this is, then its prices and how they moved. */}
            <div className={classes.panel}>
              <div className={classes.set}>
                <SetSymbol setCode={card.setCode} rarity={card.rarity} size={30} />
                <div data-testid="card-set">
                  <Text fw={600}>{card.setName}</Text>
                  <Text size="sm" c="dimmed">
                    {card.setCode.toUpperCase()} #{card.collectorNumber} · <span className={classes.capitalize}>{card.rarity}</span> ·{' '}
                    {card.releasedAt.slice(0, 4)}
                  </Text>
                </div>
              </div>
              {card.artist && (
                <Text size="sm" c="dimmed" mt="sm">
                  Illustrated by {card.artist}
                </Text>
              )}

              <section aria-label="Prices" className={classes.pricesSection}>
                {shownPrices.length === 0 ? (
                  <Text c="dimmed">Scryfall has no {currency.toUpperCase()} price for this printing.</Text>
                ) : (
                  <dl data-testid="prices" className={classes.prices}>
                    {shownPrices.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{formatPrice(value, currency)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <section aria-label="Price history">
                  <PriceHistory key={card.id} card={card} currency={currency} />
                </section>
              </section>
            </div>

            {others && (
              <section aria-label="Printings">
                <Title order={2} size="h3" mb="sm">
                  {card.printings.length} printings
                </Title>
                <ScrollArea.Autosize mah={440} type="auto" className={classes.printings}>
                  <ul>
                    {card.printings.map((p) => (
                      <li key={p.id}>
                        <Link to={`/cards/${p.id}`} aria-current={p.id === card.id ? 'page' : undefined}>
                          <SetSymbol setCode={p.setCode} size={22} />
                          <span className={classes.printingText}>
                            <span className={classes.printingSet}>{p.setName}</span>{' '}
                            <span className={classes.printingMeta}>
                              {p.setCode.toUpperCase()} #{p.collectorNumber}
                              {p.lang !== 'en' && ` · ${p.lang.toUpperCase()}`} · {p.releasedAt.slice(0, 4)}
                            </span>
                          </span>{' '}
                          <span className={classes.printingPrice}>{formatPrice(p[currency], currency)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </ScrollArea.Autosize>
              </section>
            )}
          </Stack>
        </div>
      </Container>

      <PrintingPicker
        opened={picking}
        onClose={() => setPicking(false)}
        scryfallId={card.id}
        cardName={card.name}
        currency={currency}
        onPick={(id) => navigate(`/cards/${id}`)} // the picker closes itself
      />
    </>
  )
}
