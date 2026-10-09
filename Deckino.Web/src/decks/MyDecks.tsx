import { timeAgo } from '../components/timeAgo'
import { Alert, Button, Container, Group, Modal, Select, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { IconFileImport, IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { useApiSubmit } from '../account/forms'
import { ArtHeader } from '../components/ArtHeader'
import { EmptyState } from '../components/EmptyState'
import { formats, type DeckDetail, type DeckSummary } from './deck'
import { tileGrid } from '../components/Tile'
import { DeckTabs } from './DeckTabs'
import { DeckTile } from './DeckTile'

export function NewDeck({ label = 'New deck' }: { label?: string }) {
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
              The decks you build, private unless you make one public.
            </Text>
            <DeckTabs />
          </div>
          <Group gap="sm">
            <Button component={Link} to="/decks/import" variant="default" leftSection={<IconFileImport size={18} />}>
              Import
            </Button>
            {decks && decks.length > 0 && <NewDeck />}
          </Group>
        </Group>
      </ArtHeader>

      <Container size="lg">
        {decks === undefined && (
          <div className={tileGrid} aria-busy="true">
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
          <ul className={tileGrid} aria-label="Decks">
            {decks.map((deck) => (
              <li key={deck.id}>
                <DeckTile deck={deck} to={`/decks/${deck.id}`} meta={`Updated ${timeAgo(deck.updatedAt)}`} />
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  )
}
