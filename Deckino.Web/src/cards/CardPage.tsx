import { Alert, Anchor, Container, Group, ScrollArea, Skeleton, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { ManaSymbols } from '../components/ManaSymbols'
import { getJson, type CardDetail, type CardFace } from './api'
import classes from './CardPage.module.css'

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
      {face.typeLine && <Text fw={500}>{face.typeLine}</Text>}
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
  const { id } = useParams()
  const [card, setCard] = useState<CardDetail | null>()
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    // A superseded response is ignored rather than aborted: cancelling only saves a few milliseconds of
    // database work, and in development React's double-run of effects would cancel every first load.
    let current = true
    getJson<CardDetail>(`/api/cards/${id}`)
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
        <Alert color="red" title="Card not found" role="alert">
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
          </div>

          <Stack gap="xl" className={classes.info}>
            <div className={classes.panel}>
              {singleFace ? (
                <FaceText face={card} heading={false} />
              ) : (
                card.faces.map((face, i) => <FaceText key={i} face={face} heading />) // reversible cards repeat face names
              )}
            </div>

            <dl className={classes.details}>
              <dt>Set</dt>
              <dd data-testid="card-set">
                {card.setName} ({card.setCode.toUpperCase()}) #{card.collectorNumber}
              </dd>
              <dt>Rarity</dt>
              <dd className={classes.capitalize}>{card.rarity}</dd>
              {card.artist && (
                <>
                  <dt>Artist</dt>
                  <dd>{card.artist}</dd>
                </>
              )}
              <dt>Released</dt>
              <dd>{card.releasedAt}</dd>
            </dl>

            <section aria-label="Prices">
              <Group justify="space-between" mb="sm">
                <Title order={2}>Prices</Title>
                <CurrencyToggle currency={currency} onChange={setCurrency} />
              </Group>
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
            </section>

            <section aria-label="Printings">
              <Title order={2} mb="sm">
                Printings ({card.printings.length})
              </Title>
              <ScrollArea.Autosize mah={440} type="auto" className={classes.printings}>
                <ul>
                  {card.printings.map((p) => (
                    <li key={p.id}>
                      <Link to={`/cards/${p.id}`} aria-current={p.id === card.id ? 'page' : undefined}>
                        <span>
                          {p.setName} ({p.setCode.toUpperCase()}) #{p.collectorNumber}
                          {p.lang !== 'en' && `, ${p.lang.toUpperCase()}`}
                        </span>
                        <span className={classes.printingMeta}>
                          {p.releasedAt.slice(0, 4)}
                          <span className={classes.printingPrice}>{formatPrice(p[currency], currency)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </ScrollArea.Autosize>
            </section>
          </Stack>
        </div>
      </Container>
    </>
  )
}
