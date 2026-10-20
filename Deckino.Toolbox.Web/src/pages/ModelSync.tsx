import { ActionIcon, Badge, Button, Group, Progress, ScrollArea, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core'
import { IconCloudUpload, IconDownload, IconFocusCentered, IconRefresh, IconSparkles } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { ref, useWorkspace } from '../bridge'
import { EmptyState, PageHeader, Section } from '../components'
import classes from './pages.module.css'

type Run = { run: { kind: string; modelVersion: string }; detail: string }

type ModelSync = {
  displayName: string
  description: string
  runs: Run[]
  selectedRun: Run | null
  runsStatus: string
  pullPercent: number | null
  publishStatus: string
  currentExtractor: string | null
  currentArtwork: string | null
}

// Versions are `<kind>-run-<UTC timestamp>`: the date it was trained on.
const trainedOn = (version: string) => {
  const date = /-run-(\d{4})(\d{2})(\d{2})T/.exec(version)
  return date
    ? `trained ${new Date(Date.UTC(+date[1], +date[2] - 1, +date[3])).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
    : version
}

// One model the app downloads, named as the app's Profile names it, with the version Publish would send.
function PublishRow(props: {
  icon: ReactNode
  name: string
  kind: string
  version: string | null
  onPublish: () => void
  disabled: boolean
}) {
  return (
    <Group wrap="nowrap" gap="md">
      <ThemeIcon variant="light" size={42} radius="md">
        {props.icon}
      </ThemeIcon>
      <Stack gap={0} style={{ flex: 1 }} miw={0}>
        <Text fw={700}>{props.name}</Text>
        <Text size="xs" c="dimmed" truncate title={props.version ?? undefined}>
          {props.kind} · {props.version ? trainedOn(props.version) : 'none on this PC yet'}
        </Text>
      </Stack>
      <Button size="xs" variant="default" leftSection={<IconCloudUpload size={16} />} onClick={props.onPublish} disabled={props.disabled}>
        Publish
      </Button>
    </Group>
  )
}

export default function ModelSyncPage() {
  const { state, can, run, set } = useWorkspace<ModelSync>('modelSync')
  if (!state) return null

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description} />

      {/* Publishing beside the runs, which take the rest of the window. */}
      <div className={classes.split}>
        <div className={classes.column}>
          <Section
            title="App model updates"
            subtitle="The app's extractor and artwork recognizer, published to the same bucket for apps to download."
          >
            <Text size="sm" c="dimmed">
              {state.publishStatus}
            </Text>
            <Stack mt="md" gap="sm">
              <PublishRow
                icon={<IconFocusCentered size={22} />}
                name="Card finder"
                kind="extractor"
                version={state.currentExtractor}
                onPublish={() => run('publishExtractor')}
                disabled={!can('publishExtractor')}
              />
              <PublishRow
                icon={<IconSparkles size={22} />}
                name="Card recognizer"
                kind="artwork"
                version={state.currentArtwork}
                onPublish={() => run('publishArtwork')}
                disabled={!can('publishArtwork')}
              />
            </Stack>
          </Section>
        </div>
        <Section
          fill
          title="Training runs"
          subtitle="Every finished training run uploads itself here. Pull one to make it this PC's current model."
          actions={
            <>
              <Tooltip label="List the runs again">
                <ActionIcon variant="default" size={30} onClick={() => run('refreshRuns')} disabled={!can('refreshRuns')} aria-label="List the runs again">
                  <IconRefresh size={16} />
                </ActionIcon>
              </Tooltip>
              <Button size="xs" variant="gradient" leftSection={<IconDownload size={16} />} onClick={() => run('pullRun')} disabled={!can('pullRun')}>
                Pull to this PC
              </Button>
            </>
          }
        >
          <Text size="sm" c="dimmed" mb="xs">
            {state.runsStatus}
          </Text>
          {state.pullPercent !== null && (
            // Full and striped while the downloaded run imports.
            <Progress value={state.pullPercent} size="sm" mb="sm" striped={state.pullPercent === 100} animated={state.pullPercent === 100} />
          )}
          {state.runs.length === 0 ? (
            <EmptyState title="No runs listed" message="They show here once the bucket is connected on Dataset Sync." />
          ) : (
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <Stack gap={4}>
                {state.runs.map((item) => (
                  <Group
                    key={`${item.run.kind}/${item.run.modelVersion}`}
                    className={classes.row}
                    data-selected={
                      (state.selectedRun?.run.modelVersion === item.run.modelVersion &&
                        state.selectedRun?.run.kind === item.run.kind) ||
                      undefined
                    }
                    onClick={() => set({ selectedRun: ref('runs', { 'run.kind': item.run.kind, 'run.modelVersion': item.run.modelVersion }) })}
                    wrap="nowrap"
                  >
                    <Badge variant="light" w={92}>
                      {item.run.kind}
                    </Badge>
                    <Text fw={600} size="sm" style={{ flex: 1 }} truncate>
                      {item.run.modelVersion}
                    </Text>
                    <Text ff="monospace" size="xs" c="dimmed">
                      {item.detail}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </ScrollArea>
          )}
        </Section>
      </div>
    </div>
  )
}
