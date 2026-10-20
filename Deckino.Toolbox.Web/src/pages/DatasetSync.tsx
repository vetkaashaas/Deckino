import { Button, Group, PasswordInput, ScrollArea, SimpleGrid, Stack, Switch, Text } from '@mantine/core'
import { IconPlugConnected, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { ref, useWorkspace } from '../bridge'
import { BoundTextInput, EmptyState, PageHeader, Section, StatTile, StatusPill } from '../components'
import classes from './pages.module.css'

type Conflict = { objectKey: string; relativePath: string; createdUtc: string }

type DatasetSync = {
  displayName: string
  description: string
  conflicts: Conflict[]
  endpoint: string
  bucket: string
  region: string
  forcePathStyle: boolean
  accessKeyId: string
  selectedConflict: Conflict | null
  status: string
  lastSyncLabel: string
  localFiles: number
  remoteFiles: number
  pendingUploads: number
  failedOperations: number
  isSyncRunning: boolean
  safeToSwitch: boolean
  safetyLabel: string
  hasUnsavedSecret: boolean
}

const count = (value: number) => value.toLocaleString()

export default function DatasetSyncPage() {
  const { state, can, run, set } = useWorkspace<DatasetSync>('datasetSync')
  // The secret is write-only: it never comes back from the Toolbox, and stays in this field until the Toolbox has
  // verified and stored it (which clears its copy).
  const [secret, setSecret] = useState('')
  const hasUnsavedSecret = state?.hasUnsavedSecret
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current && hasUnsavedSecret === false) {
      sent.current = false
      setSecret('')
    }
  }, [hasUnsavedSecret])
  if (!state) return null

  const saveConnection = async () => {
    if (secret) {
      await set({ secretAccessKey: secret })
      sent.current = true
    }
    await run('saveConnection')
  }

  return (
    <div className={classes.page}>
      <PageHeader
        title={state.displayName}
        subtitle={state.description}
        status={
          <StatusPill tone={state.isSyncRunning ? 'Accent' : state.safeToSwitch ? 'Success' : 'Warning'}>
            {state.safetyLabel}
          </StatusPill>
        }
      >
        <Button variant="gradient" leftSection={<IconRefresh size={18} />} onClick={() => run('syncNow')} disabled={!can('syncNow')}>
          Sync now
        </Button>
      </PageHeader>

      <Section>
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="sm">
          <StatTile label="Local files" value={count(state.localFiles)} />
          <StatTile label="Remote files" value={count(state.remoteFiles)} />
          <StatTile label="Pending uploads" value={count(state.pendingUploads)} />
          <StatTile label="Failed operations" value={count(state.failedOperations)} />
        </SimpleGrid>
        <Group justify="space-between" mt="sm" gap="xs">
          <Text size="sm" c="dimmed">
            {state.status}
          </Text>
          <Text size="sm" c="var(--deckino-dim)">
            Last successful sync {state.lastSyncLabel}
          </Text>
        </Group>
      </Section>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Section
          title="Railway bucket connection"
          subtitle="Credentials stay encrypted for the current Windows user. Downloads run only on demand."
        >
          <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm">
            <BoundTextInput label="Endpoint" value={state.endpoint} onCommit={(value) => set({ endpoint: value })} />
            <BoundTextInput label="Bucket" value={state.bucket} onCommit={(value) => set({ bucket: value })} />
            <BoundTextInput label="Region" value={state.region} onCommit={(value) => set({ region: value })} />
            <Switch
              label="Use path-style URLs"
              checked={state.forcePathStyle}
              onChange={(event) => set({ forcePathStyle: event.currentTarget.checked })}
              style={{ alignSelf: 'end' }}
              mb={8}
            />
            <BoundTextInput label="Access key ID" value={state.accessKeyId} onCommit={(value) => set({ accessKeyId: value })} />
            <PasswordInput
              label="Secret access key"
              placeholder={
                state.hasUnsavedSecret
                  ? 'Typed, not saved yet · type to replace'
                  : state.accessKeyId
                    ? 'Saved · type to replace'
                    : undefined
              }
              value={secret}
              onChange={(event) => setSecret(event.currentTarget.value)}
              autoComplete="off"
            />
          </SimpleGrid>
          <Button
            mt="md"
            variant="default"
            leftSection={<IconPlugConnected size={18} />}
            onClick={saveConnection}
            disabled={!can('saveConnection')}
          >
            Verify and save connection
          </Button>
        </Section>

        <Section
          title="Conflicts"
          subtitle="Different local and remote content is never overwritten silently."
          actions={
            <>
              <Button size="xs" variant="default" onClick={() => run('keepRemote')} disabled={!can('keepRemote')}>
                Keep remote
              </Button>
              <Button size="xs" variant="default" onClick={() => run('keepLocal')} disabled={!can('keepLocal')}>
                Keep local
              </Button>
            </>
          }
        >
          {state.conflicts.length === 0 ? (
            <EmptyState title="No conflicts" message="Local and remote copies agree." />
          ) : (
            <ScrollArea.Autosize mah={320}>
              <Stack gap={4}>
                {state.conflicts.map((conflict) => (
                  <div
                    key={conflict.objectKey}
                    className={classes.row}
                    data-selected={state.selectedConflict?.objectKey === conflict.objectKey || undefined}
                    onClick={() => set({ selectedConflict: ref('conflicts', { objectKey: conflict.objectKey }) })}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600} size="sm" truncate>
                        {conflict.relativePath}
                      </Text>
                      <Text ff="monospace" size="xs" c="dimmed">
                        {conflict.createdUtc.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </Group>
                    <Text ff="monospace" size="xs" c="var(--deckino-dim)" truncate>
                      {conflict.objectKey}
                    </Text>
                  </div>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Section>
      </SimpleGrid>

    </div>
  )
}
