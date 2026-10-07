import { Alert, Badge, Container, Group, Skeleton, Text, Title } from '@mantine/core'
import { IconTag } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError, getJson } from '../api'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { EmptyState } from '../components/EmptyState'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { entryPrice, finishLabels } from '../decks/deck'
import { conditions, languageLabel, printingLabel, type PublicBinder } from './binder'
import classes from './BinderPage.module.css'

// A shared binder, for anyone with the link: what the cards are and how many. No notes, no editing.
export default function PublicBinderPage() {
  const { id } = useParams()
  // undefined while loading; null when it doesn't exist or isn't public; 'failed' when the API didn't answer.
  const [binder, setBinder] = useState<PublicBinder | null | 'failed'>()
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    let current = true
    getJson<PublicBinder>(`/api/public/binders/${id}`)
      .then((b) => current && setBinder(b))
      .catch((e) => current && setBinder(e instanceof ApiError && e.status === 404 ? null : 'failed'))
    return () => {
      current = false
    }
  }, [id])

  if (binder === undefined) {
    return (
      <Container size="lg" py="xl" aria-busy="true">
        <Skeleton height={48} width="50%" mb="xl" />
        <Skeleton height={300} />
      </Container>
    )
  }
  if (binder === null || binder === 'failed') {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" role="alert" title={binder === null ? 'Binder not found' : "This binder didn't load"}>
          {binder === null
            ? "There's no shared binder at this address. Its owner may have made it private."
            : "Deckino didn't respond. Reload the page to try again."}
        </Alert>
      </Container>
    )
  }

  const count = binder.cards.reduce((sum, c) => sum + c.count, 0)
  const value = binder.cards.reduce((sum, c) => sum + (entryPrice(c, currency) ?? 0) * c.count, 0)
  const cover = binder.cards[0]?.card
  return (
    <>
      <ArtHeader art={cover?.artCrop ?? cover?.image}>
        <Title order={1} className={classes.title}>
          {binder.name}
        </Title>
        <Group gap="md" mt="sm" className={classes.facts}>
          <span>by {binder.owner}</span>
          <span data-testid="binder-count">
            {count} {count === 1 ? 'card' : 'cards'}
          </span>
          <span data-testid="binder-value">≈ {formatPrice(value, currency)}</span>
        </Group>
      </ArtHeader>

      <Container size="lg">
        {binder.isSelling && (
          <Alert color="purple" variant="light" icon={<IconTag />} mb="lg" title={`Cards for sale by ${binder.owner}`}>
            Contact {binder.owner} to buy. Deckino doesn't handle sales, payments or shipping.
          </Alert>
        )}

        <Group justify="flex-end" mb="sm">
          <CurrencyToggle currency={currency} onChange={setCurrency} />
        </Group>

        {binder.cards.length === 0 ? (
          <EmptyState title="This binder is empty" />
        ) : (
          <ul className={classes.rows} aria-label="Cards">
            {binder.cards.map((c) => (
              <li key={[c.scryfallId, c.finish, c.condition, c.language].join('|')} className={classes.publicRow} aria-label={c.card.name}>
                <span className={classes.count}>{c.count}×</span>
                <span className={classes.thumb}>
                  <CardImage src={c.card.image} alt={c.card.name} foil={c.finish !== 'nonfoil'} lazy />
                </span>
                <div className={classes.name}>
                  <span className={classes.cardName}>{c.card.name}</span>
                  <Text size="xs" c="dimmed">
                    {printingLabel(c.card)}
                  </Text>
                </div>
                <Group gap={6} className={classes.badges}>
                  {c.finish !== 'nonfoil' && (
                    <Badge size="sm" variant="gradient">
                      {finishLabels[c.finish]}
                    </Badge>
                  )}
                  <Badge size="sm" variant="default" title={conditions.find((x) => x.value === c.condition)?.label}>
                    {c.condition}
                  </Badge>
                  <Badge size="sm" variant="default">
                    {languageLabel(c.language)}
                  </Badge>
                  <span className={classes.price}>{formatPrice(entryPrice(c, currency), currency)}</span>
                </Group>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  )
}
