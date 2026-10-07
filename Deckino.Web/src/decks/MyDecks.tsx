import { Alert, Badge, Button, Container, Group, Modal, Select, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { useApiSubmit } from '../account/forms'
import { ArtHeader } from '../components/ArtHeader'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols } from '../components/ManaSymbols'
import { formatLabel, formats, type DeckDetail, type DeckSummary } from './deck'
import classes from './MyDecks.module.css'

function NewDeck({ label = 'New deck' }: { label?: string }) {
  const navigate = useNavigate()
  const [open, dialog] = useDisclosure()
  const form = useForm({
    initialValues: { name: '', format: 'commander' },
    validate: { name: (value) => (value.trim() ? null : 'Give the deck a name') },
  })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <>
      <Button variant="gradient" leftSection={<IconPlus size={18} />} onClick={dialog.open}>
        {label}
      </Button>
      <Modal opened={open} onClose={dialog.close} title="New deck" centered>
        <form
          onSubmit={submit(async (values) => {
            const deck = await sendJson<DeckDetail>('POST', '/api/decks', values)
            navigate(`/decks/${deck.id}`)
          })}
          noValidate
        >
          <Stack gap="md">
            {error && <Alert color="red" role="alert">{error}</Alert>}
            <TextInput label="Deck name" maxLength={100} data-autofocus {...form.getInputProps('name')} />
            <Select label="Format" data={formats} allowDeselect={false} {...form.getInputProps('format')} />
            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.close}>
                Cancel
              </Button>
              <Button type="submit" variant="gradient" loading={submitting}>
                Create deck
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  )
}

export default function MyDecks() {
  const { account } = useAuth()
  const location = useLocation()
  const [decks, setDecks] = useState<DeckSummary[] | null>()

  useEffect(() => {
    if (!account) return
    getJson<DeckSummary[]>('/api/decks')
      .then(setDecks)
      .catch(() => setDecks(null))
  }, [account])

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  return (
    <>
      <ArtHeader>
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={1}>Your decks</Title>
            <Text c="dimmed" mt="xs">
              The decks you build, private to you.
            </Text>
          </div>
          {decks && decks.length > 0 && <NewDeck />}
        </Group>
      </ArtHeader>

      <Container size="lg">
        {decks === undefined && (
          <div className={classes.grid} aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} height={180} radius="lg" />
            ))}
          </div>
        )}

        {decks === null && (
          <Alert color="red" title="Your decks didn't load" role="alert">
            Deckino didn't respond. Reload the page to try again.
          </Alert>
        )}

        {decks?.length === 0 && (
          <EmptyState title="No decks yet" action={<NewDeck label="Build your first deck" />}>
            Start a deck, pick its format, and add cards from the whole catalogue.
          </EmptyState>
        )}

        {decks && decks.length > 0 && (
          <ul className={classes.grid} aria-label="Decks">
            {decks.map((deck) => (
              <li key={deck.id}>
                <Link to={`/decks/${deck.id}`} className={classes.deck}>
                  <span
                    className={classes.cover}
                    style={deck.cover ? { backgroundImage: `url("${deck.cover}")` } : undefined}
                    aria-hidden="true"
                  />
                  <span className={classes.body}>
                    <Group gap="xs">
                      <Badge variant="light">{formatLabel(deck.format)}</Badge>
                      {deck.colorIdentity.length > 0 && (
                        <span className={classes.pips}>
                          <ManaSymbols text={deck.colorIdentity.map((c) => `{${c}}`).join('')} />
                        </span>
                      )}
                    </Group>
                    <span className={classes.name}>{deck.name}</span>
                    <Text component="span" size="sm" c="dimmed">
                      {deck.cardCount} {deck.cardCount === 1 ? 'card' : 'cards'} · Updated{' '}
                      {new Date(deck.updatedAt).toLocaleDateString()}
                    </Text>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  )
}
