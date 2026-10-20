import { Button, Group, Progress, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core'
import { IconFolderOpen, IconMovie, IconScissors } from '@tabler/icons-react'
import { ref, useWorkspace } from '../bridge'
import { PageHeader, RunButton, Section } from '../components'
import classes from './pages.module.css'

type Preset = { value: string; name: string; framesPerSecond: number; description: string }

type VideoImport = {
  displayName: string
  description: string
  presetOptions: Preset[]
  selectedPreset: Preset
  selectedVideoPath: string
  selectedVideoName: string
  videoDetails: string
  estimateLabel: string
  runtimeStatus: string
  status: string
  progressLabel: string
  progressPercent: number
  isBusy: boolean
  canConfigure: boolean
}

export default function VideoImportPage() {
  const { state, can, run, set } = useWorkspace<VideoImport>('videoImport')
  if (!state) return null

  return (
    <div className={classes.page}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Button variant="gradient" leftSection={<IconMovie size={18} />} onClick={() => run('pickVideo')} disabled={!can('pickVideo')}>
          Select video
        </Button>
      </PageHeader>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Stack gap="md">
          <Section title="Source">
            <Stack gap={6}>
              <Text fw={600}>{state.selectedVideoName}</Text>
              {state.selectedVideoPath && (
                <Tooltip label={state.selectedVideoPath}>
                  <Text ff="monospace" size="xs" c="dimmed" truncate="start" data-selectable>
                    {state.selectedVideoPath}
                  </Text>
                </Tooltip>
              )}
              <Text ff="monospace" size="xs" c="dimmed" data-selectable>
                {state.videoDetails}
              </Text>
              {state.runtimeStatus && (
                <Text size="sm" c="var(--deckino-dim)">
                  {state.runtimeStatus}
                </Text>
              )}
            </Stack>
          </Section>

          <Section title="Frame density">
            <Stack gap={4}>
              {state.presetOptions.map((preset) => (
                <div
                  key={preset.value}
                  className={classes.row}
                  data-selected={preset.value === state.selectedPreset.value || undefined}
                  style={state.canConfigure ? undefined : { pointerEvents: 'none', opacity: 0.6 }}
                  onClick={() => set({ selectedPreset: ref('presetOptions', { value: preset.value }) })}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={600} size="sm">
                      {preset.name}
                    </Text>
                    <Text size="sm" c="var(--deckino-violet)" fw={600}>
                      {preset.framesPerSecond} fps
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {preset.description}
                  </Text>
                </div>
              ))}
            </Stack>
          </Section>
        </Stack>

        <Stack gap="md">
          <Section title="Estimated output">
            <Text fw={600}>{state.estimateLabel}</Text>
            <Text size="sm" c="dimmed" mt={4}>
              Every sampled frame is retained, including blur and difficult lighting.
            </Text>
          </Section>

          <Section title="Import progress">
            <Text fw={600}>{state.progressLabel}</Text>
            <Progress value={state.progressPercent} mt="sm" size="md" animated={state.isBusy} />
            <Text size="sm" c="dimmed" mt="xs">
              {state.status}
            </Text>
            <Group mt="md" justify="space-between">
              <Button variant="subtle" color="gray" leftSection={<IconFolderOpen size={18} />} onClick={() => run('openBatch')} disabled={!can('openBatch')}>
                Open batch folder
              </Button>
              <Group gap="xs">
                <RunButton
                  busy={state.isBusy}
                  icon={<IconScissors size={18} />}
                  label="Extract frames"
                  onRun={() => run('extract')}
                  runDisabled={!can('extract') || !state.canConfigure}
                  onCancel={() => run('cancel')}
                  cancelDisabled={!can('cancel')}
                />
              </Group>
            </Group>
          </Section>
        </Stack>
      </SimpleGrid>
    </div>
  )
}
