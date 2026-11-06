import { Alert, Badge, Button, Container, Group, Stack, Table, Text, Title } from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { getJson, sendJson } from '../api'
import { useAuth } from '../account/auth'
import { ArtHeader } from '../components/ArtHeader'
import type { CatalogueStatus } from '../generated'

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

// For accounts with users.is_admin set in the database. The API checks it again for every call.
export default function AdminPage() {
  const { account } = useAuth()
  const location = useLocation()
  if (account === undefined) return null
  if (account === null) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />
  if (!account.isAdmin) return <Navigate to="/" replace />
  return (
    <>
      <ArtHeader>
        <Title order={1}>Admin</Title>
      </ArtHeader>
      <Container size="lg" pb="xl">
        <Catalogue />
      </Container>
    </>
  )
}

// The Scryfall import: it runs by itself every few hours when Scryfall has new data; "Import now" runs it anyway.
function Catalogue() {
  const [status, setStatus] = useState<CatalogueStatus>()
  const [error, setError] = useState<string>()
  const load = useCallback(
    () =>
      getJson('/api/admin/catalogue')
        .then((next) => {
          setStatus(next)
          setError(undefined)
        })
        .catch((e: Error) => setError(e.message)),
    [],
  )
  useEffect(() => void load(), [load])
  // Every few seconds while an import runs, to show when it's done.
  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [status?.running, load])

  async function importNow() {
    let failed: string | undefined
    try {
      await sendJson('POST', '/api/admin/catalogue/sync')
    } catch (e) {
      failed = (e as Error).message
    }
    await load()
    if (failed) setError(failed) // after load, which clears it
  }

  return (
    <Stack gap="md" component="section" aria-label="Card catalogue">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Card catalogue</Title>
          <Text c="dimmed" size="sm">
            Imported from Scryfall by itself when it has new data. Last checked {time(status?.lastCheckedAt ?? null)}.
          </Text>
        </div>
        <Button onClick={importNow} loading={status?.running} disabled={!status}>
          Import now
        </Button>
      </Group>
      {error && <Alert color="danger" role="alert">{error}</Alert>}
      <Table.ScrollContainer minWidth={720}>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Started</Table.Th>
              <Table.Th>Finished</Table.Th>
              <Table.Th>Scryfall data from</Table.Th>
              <Table.Th>Cards</Table.Th>
              <Table.Th>New</Table.Th>
              <Table.Th>Changed</Table.Th>
              <Table.Th>Result</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {status?.runs.map((run) => (
              <Table.Tr key={run.startedAt}>
                <Table.Td>{time(run.startedAt)}</Table.Td>
                <Table.Td>{time(run.finishedAt)}</Table.Td>
                <Table.Td>{time(run.bulkUpdatedAt)}</Table.Td>
                <Table.Td>{run.cardsRead}</Table.Td>
                <Table.Td>{run.inserted}</Table.Td>
                <Table.Td>{run.updated}</Table.Td>
                <Table.Td>
                  {run.error ? (
                    <Text c="danger" size="sm">{run.error}</Text>
                  ) : run.finishedAt ? (
                    <Badge color="success" variant="light">Done</Badge>
                  ) : (
                    <Badge variant="light">Running</Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  )
}
