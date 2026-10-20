import { Button, Group, SimpleGrid, Stack, Switch, Tabs, Text, TextInput } from '@mantine/core'
import { IconFolderOpen, IconPhotoSearch, IconPlayerPlay, IconPlayerStop, IconScan } from '@tabler/icons-react'
import { useState } from 'react'
import { useWorkspace } from '../bridge'
import { ImageWell, LogPanel, PageHeader, Section, StageList, type Stage } from '../components'
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
        <Button variant="subtle" color="gray" leftSection={<IconFolderOpen size={18} />} onClick={() => run('openExtractionFolder')}>
          Open workspace
        </Button>
        <Button variant="light" color="red" leftSection={<IconPlayerStop size={18} />} onClick={() => run('cancel')} disabled={!can('cancel')}>
          Cancel
        </Button>
        <Button variant="gradient" leftSection={<IconPlayerPlay size={18} />} onClick={() => run('runFull')} disabled={!can('runFull')}>
          Train latest extractor
        </Button>
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
            <Section
              title="Production workflow"
              subtitle="Train from the latest annotations. Compatible unfinished runs resume automatically."
            >
              <Switch
                label="Include synthetic cards"
                checked={state.includeSyntheticCards}
                disabled={!state.canChangeTrainingOptions}
                onChange={(event) => set({ includeSyntheticCards: event.currentTarget.checked })}
              />
              <Text size="sm" c="dimmed" mt="sm">
                {state.assetSummary}
              </Text>
              <Text size="sm" c="dimmed" mt={4}>
                {state.gpuSummary}
              </Text>
            </Section>
            <Section title="Stages">
              <StageList stages={state.stages} />
            </Section>
            <Section title="Share between PCs">
              <Text size="sm" c="dimmed">
                {state.handoffSummary}
              </Text>
              <Button mt="md" variant="default" leftSection={<IconFolderOpen size={18} />} onClick={() => run('openHandoffFolder')}>
                Open handoff folder
              </Button>
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
