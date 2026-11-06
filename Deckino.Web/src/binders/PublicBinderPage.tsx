import { Alert, Container, Group, Skeleton, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError, getJson } from '../api'
import { ArtHeader } from '../components/ArtHeader'
import { EmptyState } from '../components/EmptyState'
import { formatPrice, useCurrency } from '../components/currency'
import { entryPrice } from '../decks/deck'
import { type PublicBinder } from './binder'
import { CopyCells } from './CopyCells'
import classes from './BinderPage.module.css'
import { Icon } from '../components/Icon'

// A shared binder, for anyone with the link: what the cards are and how many. No notes, no editing.
export default function PublicBinderPage() {
  const { id } = useParams()
  // undefined while loading; null when it doesn't exist or isn't public; 'failed' when the API didn't answer.
  const [binder, setBinder] = useState<PublicBinder | null | 'failed'>()
  const [currency] = useCurrency()

  useEffect(() => {
    let current = true
    getJson(`/api/public/binders/${id}`)
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
        <Alert color="danger" role="alert" title={binder === null ? 'Binder not found' : "This binder didn't load"}>
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
          <Alert color="purple" variant="light" icon={<Icon name="sell" />} mb="lg" title={`Cards for sale by ${binder.owner}`}>
            Contact {binder.owner} to buy. Deckino doesn't handle sales, payments or shipping.
          </Alert>
        )}

        {binder.cards.length === 0 ? (
          <EmptyState title="This binder is empty" />
        ) : (
          <ul className={classes.rows} aria-label="Cards">
            {binder.cards.map((c) => (
              <li key={[c.scryfallId, c.finish, c.condition, c.language].join('|')} className={classes.publicRow} aria-label={c.card.name}>
                <div className={classes.open}>
                  <CopyCells {...c} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  )
}
