import { Alert, Button, Group, Progress, Text } from '@mantine/core'
import { IconAlertTriangle, IconFolderOpen, IconPlayerStop, IconRefresh, IconRotateClockwise, IconSearch } from '@tabler/icons-react'
import { useWorkspace } from '../bridge'
import { LogPanel, PageHeader, Section, StageList, StatTile, StatusPill, type Stage, type Tone } from '../components'
import classes from './pages.module.css'

type Sync = {
  displayName: string
  description: string
  stages: Stage[]
  liveLog: string[]
  selectedLogLine: string | null
  isBusy: boolean
  isIdle: boolean
  freshnessText: string
  freshnessTone: Tone
  status: string
  lastRunText: string
  errorMessage: string
  printings: string
  oracleCards: string
  sets: string
  imagesCached: string
  imagesCaption: string
  imagesPercent: number
  imagesFailed: string
  diskUsed: string
  hasFailures: boolean
}

export default function SyncPage() {
  const { state, can, run, set } = useWorkspace<Sync>('sync')
  if (!state) return null

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader
        title={state.displayName}
        subtitle={state.description}
        status={<StatusPill tone={state.freshnessTone}>{state.freshnessText}</StatusPill>}
      >
        <Button variant="subtle" color="gray" leftSection={<IconFolderOpen size={18} />} onClick={() => run('openImageFolder')}>
          Open image folder
        </Button>
        {state.hasFailures && (
          <Button
            variant="default"
            leftSection={<IconRotateClockwise size={18} />}
            onClick={() => run('retryFailed')}
            disabled={!can('retryFailed')}
            title="Download the card images that failed again; their reasons are in the activity log"
          >
            Retry failed
          </Button>
        )}
        <Button
          variant="default"
          leftSection={<IconSearch size={18} />}
          onClick={() => run('checkForUpdates')}
          disabled={!can('checkForUpdates')}
          title="Compare Scryfall's latest bulk files with this computer without downloading anything"
        >
          Check for updates
        </Button>
        {state.isBusy && (
          <Button color="red" variant="light" leftSection={<IconPlayerStop size={18} />} onClick={() => run('cancel')} disabled={!can('cancel')}>
            Cancel
          </Button>
        )}
        {state.isIdle && (
          <Button variant="gradient" leftSection={<IconRefresh size={18} />} onClick={() => run('sync')} disabled={!can('sync')}>
            Sync now
          </Button>
        )}
      </PageHeader>

      {/* Errors stay until dismissed, with the full detail one click away. */}
      {state.errorMessage && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle />} radius="md">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" c="var(--deckino-danger)" fw={600} data-selectable>
              {state.errorMessage}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Button size="xs" variant="subtle" color="gray" onClick={() => run('copyError')}>
                Copy details
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={() => run('dismissError')}>
                Dismiss
              </Button>
            </Group>
          </Group>
        </Alert>
      )}

      <Section>
        <div className={classes.stats}>
          <StatTile label="Printings" value={state.printings} caption="one per artwork" />
          <StatTile label="Oracle cards" value={state.oracleCards} caption="unique cards" />
          <StatTile label="Sets" value={state.sets} caption="in the catalogue" />
          <StatTile label="Card images" value={state.imagesCached} caption={state.imagesCaption} />
          <StatTile label="Failed" value={state.imagesFailed} caption="kept until retried" />
          <StatTile label="Disk used" value={state.diskUsed} caption="card-images folder" />
        </div>
        <Progress value={state.imagesPercent} mt="md" size="sm" />
        <Text size="sm" c="dimmed" mt="xs">
          {state.status}
        </Text>
      </Section>

      <div className={classes.split}>
        <div className={classes.column}>
          <Section title="Pipeline" subtitle={state.lastRunText}>
            <StageList stages={state.stages} />
          </Section>
        </div>
        <LogPanel
          lines={state.liveLog}
          selected={state.selectedLogLine}
          onSelect={(line) => set({ selectedLogLine: line })}
          onOpenFolder={() => run('openLogFolder')}
          onClear={() => run('clearLog')}
          onCopySelected={() => run('copySelectedLog')}
          onCopyAll={() => run('copyAllLogs')}
        />
      </div>
    </div>
  )
}
