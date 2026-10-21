import { ActionIcon, Button, Drawer, Group, Stack, Text, Tooltip } from '@mantine/core'
import {
  IconChecklist,
  IconDeviceMobile,
  IconFolderOpen,
  IconPackage,
  IconPlayerPlay,
  IconStethoscope,
} from '@tabler/icons-react'
import { useWorkspace } from '../bridge'
import { Dot, LogPanel, PageHeader, RunButton, Section, StageList, statusTone, type Stage } from '../components'
import classes from './pages.module.css'

type Runner = {
  displayName: string
  description: string
  liveLog: string[]
  selectedLogLine: string | null
  requirementChecks: { name: string; detail: string; state: string }[]
  productionStages: Stage[]
  status: string
  requirementsHeadline: string
  requirementsCaption: string
  environmentReady: boolean
  canInstallPackages: boolean
  showRequirementDetails: boolean
  isBusy: boolean
  canRunProduction: boolean
  productionActionHint: string
  productionSummary: string
  artworkModelSummary: string
}

export default function RunnerPage() {
  const { state, can, run, set } = useWorkspace<Runner>('runner')
  if (!state) return null

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Tooltip label="Open training folder">
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => run('openTrainingFolder')} aria-label="Open training folder">
            <IconFolderOpen size={20} />
          </ActionIcon>
        </Tooltip>
        <RunButton
          busy={state.isBusy}
          icon={<IconPlayerPlay size={18} />}
          label="Train"
          onRun={() => run('runProduction')}
          runDisabled={!can('runProduction') || !state.canRunProduction}
          onCancel={() => run('cancel')}
        />
      </PageHeader>

      <Section>
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Group gap="md" wrap="nowrap" miw={0}>
            <Dot tone={state.environmentReady ? 'Success' : 'Warning'} />
            <Stack gap={0} miw={0}>
              <Text fw={700}>{state.requirementsHeadline}</Text>
              <Tooltip label={state.requirementsCaption}>
                <Text size="sm" c="dimmed" truncate>
                  {state.requirementsCaption}
                </Text>
              </Tooltip>
            </Stack>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Button
              variant="subtle"
              color="gray"
              leftSection={<IconChecklist size={18} />}
              onClick={() => set({ showRequirementDetails: !state.showRequirementDetails })}
            >
              Checklist
            </Button>
            <Button variant="default" leftSection={<IconStethoscope size={18} />} onClick={() => run('checkRequirements')} disabled={state.isBusy}>
              Check requirements
            </Button>
            <Button
              variant="default"
              leftSection={<IconPackage size={18} />}
              onClick={() => run('installPackages')}
              disabled={state.isBusy || !state.canInstallPackages}
            >
              Install required packages
            </Button>
          </Group>
        </Group>
      </Section>

      <div className={classes.split}>
        <div className={classes.column}>
          <Section>
            <Text size="sm" fw={600}>
              {state.productionSummary}
            </Text>
            {state.productionActionHint && (
              <Text size="xs" c="var(--deckino-warning)" mt={4}>
                {state.productionActionHint}
              </Text>
            )}
            <Group gap="xs" wrap="nowrap" mt="sm" pt="sm" style={{ borderTop: 'var(--deckino-hairline)' }}>
              <Stack gap={0} style={{ flex: 1 }} miw={0}>
                <Text size="xs" fw={600}>
                  Current card recognizer
                </Text>
                <Text size="xs" c="dimmed" truncate title={state.artworkModelSummary}>
                  {state.artworkModelSummary}
                </Text>
              </Stack>
              <Tooltip label="Build the phone app files from this PC's card recognizer (CPU). The Android start script also does this.">
                <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => run('exportArtworkForApp')} disabled={state.isBusy} aria-label="Build phone files">
                  <IconDeviceMobile size={20} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Open the results folder, to share runs between PCs">
                <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => run('openResultsFolder')} aria-label="Open the results folder">
                  <IconFolderOpen size={20} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Section>
          <Section title="Stages">
            <StageList stages={state.productionStages} steps />
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

      <Drawer
        opened={state.showRequirementDetails}
        onClose={() => set({ showRequirementDetails: false })}
        position="right"
        size={420}
        title={<Text fw={700}>Environment checklist</Text>}
        overlayProps={{ blur: 2 }}
      >
        <Stack gap={0}>
          {state.requirementChecks.map((check) => (
            <Group key={check.name} gap="sm" wrap="nowrap" align="flex-start" py={10} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ paddingTop: 5 }}>
                <Dot tone={statusTone(check.state)} />
              </div>
              <Stack gap={2} miw={0}>
                <Text fw={600} size="sm">
                  {check.name}
                </Text>
                <Text size="xs" c="dimmed" data-selectable>
                  {check.detail}
                </Text>
              </Stack>
            </Group>
          ))}
        </Stack>
      </Drawer>
    </div>
  )
}
