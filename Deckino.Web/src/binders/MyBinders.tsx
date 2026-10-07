import { Alert, Button, Container, Group, Modal, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { IconFileImport, IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { useApiSubmit } from '../account/forms'
import { ArtHeader } from '../components/ArtHeader'
import { useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { EmptyState } from '../components/EmptyState'
import { CollectionValue } from './CollectionValue'
import { tileGrid } from '../components/Tile'
import { BinderTile } from './BinderTile'
import type { BinderDetail, BinderSummary } from './binder'

function NewBinder({ label = 'New binder' }: { label?: string }) {
  const navigate = useNavigate()
  const [open, dialog] = useDisclosure()
  const form = useForm({
    initialValues: { name: '' },
    validate: { name: (value) => (value.trim() ? null : 'Give the binder a name') },
  })
  const { submit, error, submitting } = useApiSubmit(form)

  return (
    <>
      <Button variant="gradient" leftSection={<IconPlus size={18} />} onClick={dialog.open}>
        {label}
      </Button>
      <Modal opened={open} onClose={dialog.close} title="New binder" centered>
        <form
          onSubmit={submit(async (values) => {
            const binder = await sendJson<BinderDetail>('POST', '/api/binders', values)
            navigate(`/binders/${binder.id}`)
          })}
          noValidate
        >
          <Stack gap="md">
            {error && <Alert color="red" role="alert">{error}</Alert>}
            <TextInput label="Binder name" maxLength={100} data-autofocus {...form.getInputProps('name')} />
            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.close}>
                Cancel
              </Button>
              <Button type="submit" variant="gradient" loading={submitting}>
                Create binder
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  )
}

export default function MyBinders() {
  const { account } = useAuth()
  const location = useLocation()
  const [binders, setBinders] = useState<BinderSummary[] | null>()
  const [currency, setCurrency] = useCurrency()

  useEffect(() => {
    if (!account) return
    getJson<BinderSummary[]>('/api/binders')
      .then(setBinders)
      .catch(() => setBinders(null))
  }, [account])

  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />

  return (
    <>
      <ArtHeader>
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={1}>Your binders</Title>
            <Text c="dimmed" mt="xs">
              The physical cards you own, one record per card. Private unless you share a binder.
            </Text>
          </div>
          <Group gap="sm">
            {binders && binders.length > 0 && <CurrencyToggle currency={currency} onChange={setCurrency} />}
            <Button component={Link} to="/binders/import" variant="default" leftSection={<IconFileImport size={18} />}>
              Import
            </Button>
            {binders && binders.length > 0 && <NewBinder />}
          </Group>
        </Group>
      </ArtHeader>

      <Container size="lg">
        {binders && binders.length > 0 && <CollectionValue currency={currency} />}

        {binders === undefined && (
          <div className={tileGrid} aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} height={180} radius="lg" />
            ))}
          </div>
        )}

        {binders === null && (
          <Alert color="red" title="Your binders didn't load" role="alert">
            Deckino didn't respond. Reload the page to try again.
          </Alert>
        )}

        {binders?.length === 0 && (
          <EmptyState title="No binders yet" action={<NewBinder label="Start your first binder" />}>
            A binder holds your physical cards: the exact printing, finish, condition and language of each one.
          </EmptyState>
        )}

        {binders && binders.length > 0 && (
          <ul className={tileGrid} aria-label="Binders">
            {binders.map((binder) => (
              <li key={binder.id}>
                <BinderTile binder={binder} />
              </li>
            ))}
          </ul>
        )}
      </Container>
    </>
  )
}
