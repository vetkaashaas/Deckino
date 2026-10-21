import { ActionIcon, Button, Group, Pagination, Progress, ScrollArea, Stack, Text, Tooltip } from '@mantine/core'
import { IconFolderOpen, IconLibraryPlus, IconMovie, IconScissors, IconTrash } from '@tabler/icons-react'
import { memo, useCallback, useReducer } from 'react'
import { ref, useWorkspace } from '../bridge'
import { EmptyState, PageHeader, PhotoTile, RunButton, Section } from '../components'
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
  reviewFrames: string[]
  reviewFolder: string
}

// Pages of frames, as on Photo Library: a long video makes thousands.
const pageSize = 60

// Which frames are left out lives here until "Add to library": a click sends nothing, so a long video's thousands of
// frames aren't sent back with every tick. Kept outside the page, so leaving it and coming back keeps the picks.
// `sending`: from the click on Add until its reply (which says isBusy), so no tick slips in between.
let picks = { reviewFolder: '', leftOut: new Set<string>(), page: 1, sending: false }

// Locked while the frames are being added: the picks have been sent.
const FrameTile = memo(function FrameTile(props: { folder: string; name: string; kept: boolean; locked: boolean; onToggle: (name: string) => void }) {
  return (
    <PhotoTile
      src={`/api/thumbnails?path=${encodeURIComponent(`${props.folder}\\${props.name}`)}`}
      name={props.name}
      checked={props.kept}
      onToggle={() => props.onToggle(props.name)}
      disabled={props.locked}
      dimUnticked
      // A frame is away for a moment while an add that fails is put back.
      retry
    />
  )
})

export default function VideoImportPage() {
  const { state, can, run, set } = useWorkspace<VideoImport>('videoImport')
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  // The same function every time, so a tick redraws only the tile it changed.
  const toggle = useCallback((name: string) => {
    const next = new Set(picks.leftOut)
    if (!next.delete(name)) next.add(name)
    picks = { ...picks, leftOut: next }
    redraw()
  }, [])
  if (!state) return null

  if (picks.reviewFolder !== state.reviewFolder) picks = { reviewFolder: state.reviewFolder, leftOut: new Set(), page: 1, sending: false }
  const frames = state.reviewFrames
  const leftOut = picks.leftOut
  const kept = frames.length - leftOut.size
  const pages = Math.max(1, Math.ceil(frames.length / pageSize))
  const locked = state.isBusy || picks.sending
  const pick = (next: Partial<typeof picks>) => {
    picks = { ...picks, ...next }
    redraw()
  }

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Button variant="gradient" leftSection={<IconMovie size={18} />} onClick={() => run('pickVideo')} disabled={!can('pickVideo')}>
          Select video
        </Button>
      </PageHeader>

      {/* Setting up the extraction beside the frames it made, which take the rest of the window. */}
      <div className={classes.split}>
        <div className={classes.column}>
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
            <Text fw={600} size="sm" mt="sm">
              {state.estimateLabel}
            </Text>
          </Section>

          <Section title="Extraction">
            <Text fw={600}>{state.progressLabel}</Text>
            <Progress value={state.progressPercent} mt="sm" size="md" animated={state.isBusy} />
            <Text size="sm" c="dimmed" mt="xs">
              {state.status}
            </Text>
            <Group mt="md" justify="flex-end" gap="xs">
              <Tooltip label="Open the batch folder">
                <ActionIcon variant="default" size={36} onClick={() => run('openBatch')} disabled={!can('openBatch')} aria-label="Open the batch folder">
                  <IconFolderOpen size={18} />
                </ActionIcon>
              </Tooltip>
              <RunButton
                // Only extracting can be cancelled; adding frames to the library takes a moment.
                busy={can('cancel')}
                icon={<IconScissors size={18} />}
                label="Extract frames"
                onRun={() => run('extract')}
                runDisabled={!can('extract')}
                onCancel={() => run('cancel')}
              />
            </Group>
          </Section>
        </div>

        <Section
          fill
          title="Review frames"
          subtitle={
            frames.length > 0
              ? `${kept.toLocaleString()} of ${frames.length.toLocaleString()} frames kept. Click a frame to leave it out.`
              : 'Every sampled frame shows here first, blurry ones too. Only the ones you keep go to the library.'
          }
          actions={
            frames.length > 0 && (
              <>
                <Button size="xs" variant="subtle" onClick={() => pick({ leftOut: leftOut.size === 0 ? new Set(frames) : new Set() })} disabled={locked}>
                  {leftOut.size === 0 ? 'Deselect all' : 'Select all'}
                </Button>
                <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={() => run('discard')} disabled={!can('discard')}>
                  Discard
                </Button>
                <Button
                  size="xs"
                  variant="gradient"
                  leftSection={<IconLibraryPlus size={16} />}
                  onClick={() => {
                    pick({ sending: true })
                    void run('addToLibrary', [...leftOut]).finally(() => pick({ sending: false }))
                  }}
                  disabled={!can('addToLibrary') || kept === 0 || locked}
                >
                  Add {kept.toLocaleString()} to library
                </Button>
              </>
            )
          }
        >
          {frames.length === 0 ? (
            <EmptyState icon={<IconMovie size={22} />} title="No frames to review" message="Select a video and extract its frames." />
          ) : (
            <>
              {/* Keyed by page, so a new page starts at the top. */}
              <ScrollArea key={picks.page} style={{ flex: 1, minHeight: 0 }}>
                <div className={classes.tiles} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', paddingRight: 14 }}>
                  {frames.slice((picks.page - 1) * pageSize, picks.page * pageSize).map((name) => (
                    <FrameTile key={name} folder={state.reviewFolder} name={name} kept={!leftOut.has(name)} locked={locked} onToggle={toggle} />
                  ))}
                </div>
              </ScrollArea>
              {pages > 1 && (
                <Group justify="flex-end" mt="sm">
                  <Pagination size="sm" radius="xl" total={pages} value={picks.page} onChange={(page) => pick({ page })} withEdges />
                </Group>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  )
}
