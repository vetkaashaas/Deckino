import { ActionIcon, Button, Group, SimpleGrid, Stack, Switch, Tabs, Text, TextInput, Tooltip } from '@mantine/core'
import { IconFolderOpen, IconPhotoSearch, IconPlayerPlay, IconScan } from '@tabler/icons-react'
import { useState } from 'react'
import { useWorkspace } from '../bridge'
import { ImageWell, LogPanel, PageHeader, RunButton, Section, StageList, type Stage } from '../components'
import classes from './pages.module.css'

type ExtractionTraining = {
  displayName: string
  description: string
  stages: Stage[]
  liveLog: string[]
  selectedLogLine: string | null
  status: string
  assetSummary: string
  includeSyntheticCards: boolean
  diagnosticImagePath: string
  diagnosticOutputPath: string
  diagnosticOverlayUrl: string | null
  rectifiedPreviewUrl: string | null
  recognitionCropPreviewUrl: string | null
  diagnosticCropStatus: string
  diagnosticSummary: string
  isBusy: boolean
  gpuSummary: string
  handoffSummary: string
  canChangeTrainingOptions: boolean
}

export default function ExtractionTrainingPage() {
  const { state, can, run, set } = useWorkspace<ExtractionTraining>('extractionTraining')
  const [tab, setTab] = useState<string | null>('train')
  if (!state) return null

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Tooltip label="Open workspace folder">
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => run('openExtractionFolder')} aria-label="Open workspace folder">
            <IconFolderOpen size={20} />
          </ActionIcon>
        </Tooltip>
        <RunButton
          busy={state.isBusy}
          icon={<IconPlayerPlay size={18} />}
          label="Train"
          onRun={() => run('runFull')}
          runDisabled={!can('runFull')}
          onCancel={() => run('cancel')}
          cancelDisabled={!can('cancel')}
        />
      </PageHeader>

      <Tabs value={tab} onChange={setTab} variant="pills" radius="xl">
        <Tabs.List>
          <Tabs.Tab value="train" leftSection={<IconPlayerPlay size={16} />}>
            Train
          </Tabs.Tab>
          <Tabs.Tab value="diagnostic" leftSection={<IconScan size={16} />}>
            Diagnostic
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {tab === 'train' ? (
        <div className={classes.split}>
          <div className={classes.column}>
            <Section>
              <Switch
                label="Include synthetic cards"
                checked={state.includeSyntheticCards}
                disabled={!state.canChangeTrainingOptions}
                onChange={(event) => set({ includeSyntheticCards: event.currentTarget.checked })}
              />
              <Stack gap={2} mt="sm">
                <Text size="xs" c="dimmed">
                  {state.assetSummary}
                </Text>
                <Text size="xs" c="dimmed">
                  {state.gpuSummary}
                </Text>
              </Stack>
              <Group gap="xs" wrap="nowrap" mt="sm" pt="sm" style={{ borderTop: 'var(--deckino-hairline)' }}>
                <Stack gap={0} style={{ flex: 1 }} miw={0}>
                  <Text size="xs" fw={600}>
                    Current card finder
                  </Text>
                  <Text size="xs" c="dimmed" truncate title={state.handoffSummary}>
                    {state.handoffSummary}
                  </Text>
                </Stack>
                <Tooltip label="Open the handoff folder, to share runs between PCs">
                  <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => run('openHandoffFolder')} aria-label="Open the handoff folder">
                    <IconFolderOpen size={20} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Section>
            <Section title="Stages">
              <StageList stages={state.stages} steps />
            </Section>
          </div>
          <LogPanel
            title={state.status}
            lines={state.liveLog}
            selected={state.selectedLogLine}
            onSelect={(line) => set({ selectedLogLine: line })}
            onOpenFolder={() => run('openLogFolder')}
            onClear={() => run('clearAllLogs')}
            onCopySelected={() => run('copySelectedLog')}
            onCopyAll={() => run('copyAllLogs')}
          />
        </div>
      ) : (
        <div className={classes.column} style={{ flex: 1 }}>
          <Section title="Rectification diagnostic" subtitle={state.diagnosticSummary}>
            <Group gap="xs" wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                readOnly
                placeholder="Choose an owned camera photograph"
                value={state.diagnosticImagePath}
              />
              <Button variant="default" leftSection={<IconPhotoSearch size={18} />} onClick={() => run('pickDiagnosticImage')} disabled={!can('pickDiagnosticImage')}>
                Choose image
              </Button>
              <Button variant="gradient" leftSection={<IconScan size={18} />} onClick={() => run('runDiagnostic')} disabled={!can('runDiagnostic')}>
                Rectify preview
              </Button>
            </Group>
            <Stack gap={2} mt="sm">
              <Text size="sm" c="dimmed">
                {state.diagnosticCropStatus}
              </Text>
              {state.diagnosticOutputPath && (
                <Text ff="monospace" size="xs" c="var(--deckino-dim)" truncate="start" data-selectable>
                  {state.diagnosticOutputPath}
                </Text>
              )}
            </Stack>
          </Section>
          <SimpleGrid cols={3} spacing="md" style={{ flex: 1, minHeight: 320 }}>
            <Section fill title="Prediction + ground truth">
              <ImageWell src={state.diagnosticOverlayUrl} alt="Predicted and annotated corners" fill />
            </Section>
            <Section fill title="315 × 440 + identity crop">
              <ImageWell src={state.rectifiedPreviewUrl} alt="Rectified card with the identity crop" fill />
            </Section>
            <Section fill title="224 × 224 inspection crop">
              <ImageWell src={state.recognitionCropPreviewUrl} alt="Recognition crop" fill />
            </Section>
          </SimpleGrid>
        </div>
      )}
    </div>
  )
}
