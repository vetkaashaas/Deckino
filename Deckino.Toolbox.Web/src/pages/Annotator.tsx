import { ActionIcon, Button, Group, Loader, Stack, Switch, Text, Tooltip } from '@mantine/core'
import {
  IconArrowBackUp,
  IconArrowsMaximize,
  IconCheck,
  IconEraser,
  IconFolderPlus,
  IconInfoCircle,
  IconListCheck,
  IconMagnet,
  IconPlayerSkipForward,
  IconRefresh,
  IconRotateClockwise,
  IconSquareOff,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../bridge'
import { BoundTextInput, ImageWell, isTyping, PageHeader, Section } from '../components'
import AnnotationCanvas, { type CanvasControls, type Point } from './AnnotationCanvas'
import classes from './pages.module.css'
import styles from './Annotator.module.css'

type Annotator = {
  displayName: string
  description: string
  points: Point[]
  currentImageUrl: string | null
  perspectivePreviewUrl: string | null
  currentFileName: string
  currentRelativePath: string
  status: string
  geometryStatus: string
  geometryIsValid: boolean
  isBusy: boolean
  isLoadingWorkspace: boolean
  useModelSuggestions: boolean
  snapSuggestions: boolean
  isSuggesting: boolean
  suggestionIsWarning: boolean
  suggestionStatus: string
  isReviewingAnnotations: boolean
  reviewPosition: string
  currentImageWidth: number
  currentImageHeight: number
  captureCondition: string
  newestFirst: boolean
  queueSummary: string
  nextCornerName: string
}

const Key = ({ children }: { children: string }) => <span className={classes.kbd}>{children}</span>

export default function AnnotatorPage() {
  const { state, can, run, set } = useWorkspace<Annotator>('annotator')
  const canvas = useRef<CanvasControls>(null)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return
      const command = (name: string) => {
        event.preventDefault()
        if (can(name)) run(name)
      }
      const key = event.key.toLowerCase()
      if (event.ctrlKey && key === 'z') command('undo')
      else if (event.ctrlKey || event.altKey || event.metaKey) return
      // A held key browses and zooms, but never saves or labels photo after photo unseen.
      else if (event.repeat && !['arrowleft', 'arrowright', '+', '=', '-'].includes(key)) return
      else if (key === 'enter') !(event.target as HTMLElement).closest('button') && command('saveNext')
      else if (key === 'n') command('markNoCardNext')
      else if (key === 's') command('skip')
      else if (key === 'arrowright') command('moveNext')
      else if (key === 'arrowleft') command('movePrevious')
      else if (key === 'r') command('rotatePointsClockwise')
      else if (key === 'delete' || key === 'backspace') command('clearPoints')
      else if (key === 'e') command('snapToEdges')
      else if (key === '+' || key === '=') canvas.current?.zoomIn()
      else if (key === '-') canvas.current?.zoomOut()
      else if (key === '0') canvas.current?.reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [can, run])

  if (!state) return null
  const placing = state.points.length < 4 && !!state.currentImageUrl

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Switch label="Newest first" checked={state.newestFirst} onChange={(event) => set({ newestFirst: event.currentTarget.checked })} mr="xs" />
        <Tooltip label="Refresh queue">
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => run('refresh')} disabled={state.isBusy} aria-label="Refresh queue">
            <IconRefresh size={20} />
          </ActionIcon>
        </Tooltip>
        <Button variant="default" leftSection={<IconListCheck size={18} />} onClick={() => run('reviewAnnotated')} disabled={state.isBusy}>
          Review annotated
        </Button>
        <Button variant="gradient" leftSection={<IconFolderPlus size={18} />} onClick={() => run('importFolders')} disabled={state.isBusy}>
          Import folder
        </Button>
      </PageHeader>

      <div className={classes.info}>
        <Text fw={600}>{state.currentFileName}</Text>
        <Text ff="monospace" size="xs" c="var(--deckino-dim)" style={{ flex: 1 }} truncate data-selectable>
          {state.currentRelativePath}
        </Text>
        {state.reviewPosition && (
          <Text size="sm" fw={600} c="var(--deckino-lavender)">
            {state.reviewPosition}
          </Text>
        )}
        <Text fw={600} size="sm" c="var(--deckino-violet)" style={{ whiteSpace: 'pre' }}>
          {state.queueSummary}
        </Text>
      </div>

      <div className={styles.layout}>
        <div className={styles.stage}>
          <AnnotationCanvas
            ref={canvas}
            imageUrl={state.currentImageUrl}
            imageWidth={state.currentImageWidth}
            imageHeight={state.currentImageHeight}
            points={state.points}
            loading={state.isLoadingWorkspace}
            onAdd={(point) => run('addCorner', point)}
            onPlace={(index, point) => run('placeCorner', { index, x: point.x, y: point.y })}
            onZoomChange={setZoom}
          />
          <Group className={`${styles.toolbar} ${styles.edit}`} gap={4}>
            <Tooltip label="Undo (Ctrl+Z)">
              <ActionIcon variant="subtle" color="gray" onClick={() => run('undo')} disabled={!can('undo')} aria-label="Undo">
                <IconArrowBackUp size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Rotate the corner labels clockwise (R): TopLeft goes to the old BottomLeft. Press twice if off by two.">
              <ActionIcon variant="subtle" color="gray" onClick={() => run('rotatePointsClockwise')} disabled={!can('rotatePointsClockwise')} aria-label="Rotate corner labels">
                <IconRotateClockwise size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Clear all points (Del)">
              <ActionIcon variant="subtle" color="gray" onClick={() => run('clearPoints')} disabled={!can('clearPoints')} aria-label="Clear all points">
                <IconEraser size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Snap the points to the card's edges with the trained corner refiner (E). Check the result before saving.">
              <ActionIcon variant="subtle" color="gray" onClick={() => run('snapToEdges')} disabled={!can('snapToEdges')} aria-label="Snap points to edges">
                <IconMagnet size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Group className={styles.toolbar} gap={4}>
            <Tooltip label="Zoom out (−)">
              <ActionIcon variant="subtle" color="gray" onClick={() => canvas.current?.zoomOut()} aria-label="Zoom out">
                <IconZoomOut size={18} />
              </ActionIcon>
            </Tooltip>
            <Text size="xs" ff="monospace" w={40} ta="center" c="dimmed">
              {Math.round(zoom * 100)}%
            </Text>
            <Tooltip label="Fit photo to view (0)">
              <ActionIcon variant="subtle" color="gray" onClick={() => canvas.current?.reset()} aria-label="Fit photo to view">
                <IconArrowsMaximize size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Zoom in (+)">
              <ActionIcon variant="subtle" color="gray" onClick={() => canvas.current?.zoomIn()} aria-label="Zoom in">
                <IconZoomIn size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </div>

        <div className={styles.rail}>
          <Section fill>
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
              <Text size="sm" fw={700} c={state.geometryIsValid ? 'var(--deckino-success)' : placing ? 'var(--deckino-violet)' : undefined}>
                {placing ? `Place next: ${state.nextCornerName}` : state.geometryStatus}
              </Text>
              <Tooltip label="Click the four corners in order: top left, top right, bottom right, bottom left. Place each where the two straight card edges would meet, not on the rounded corner, and line the dashed guides up with the card's edges. Leave sleeves out.">
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label="How to place corners">
                  <IconInfoCircle size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
            <ImageWell src={state.perspectivePreviewUrl} alt="The card, straightened" placeholder="Place four corners to see the card straightened" fill />
          </Section>

          <Section>
            <Stack gap={8}>
              <Switch
                size="xs"
                label="Suggest corners with the current model"
                checked={state.useModelSuggestions}
                onChange={(event) => set({ useModelSuggestions: event.currentTarget.checked })}
              />
              <Tooltip label="Move each confident suggestion onto the card's edges with the extractor's full-resolution corner refiner.">
                <Switch
                  size="xs"
                  label="Snap them to edges"
                  checked={state.snapSuggestions}
                  disabled={!state.useModelSuggestions}
                  onChange={(event) => set({ snapSuggestions: event.currentTarget.checked })}
                  style={{ alignSelf: 'flex-start' }}
                />
              </Tooltip>
            </Stack>
            {/* Only a suggestion that went wrong says so; the points on the photo show the rest. */}
            {(state.isSuggesting || state.suggestionIsWarning) && (
              <Group gap={8} wrap="nowrap" align="flex-start" mt={6}>
                {state.isSuggesting && <Loader size={12} mt={2} />}
                <Text size="xs" c={state.suggestionIsWarning ? 'var(--deckino-warning)' : 'dimmed'}>
                  {state.isSuggesting ? 'Suggesting corners…' : state.suggestionStatus}
                </Text>
              </Group>
            )}
            <BoundTextInput
              mt="sm"
              size="xs"
              placeholder="Capture condition (optional)"
              aria-label="Capture condition"
              value={state.captureCondition}
              onCommit={(value) => set({ captureCondition: value })}
            />
            <Stack gap={6} mt="sm">
              <Button variant="gradient" leftSection={<IconCheck size={18} />} onClick={() => run('saveNext')} disabled={!can('saveNext')}>
                Save &amp; next
              </Button>
              <Group grow gap={6}>
                <Button variant="default" leftSection={<IconPlayerSkipForward size={16} />} onClick={() => run('skip')} disabled={!can('skip')}>
                  Skip
                </Button>
                <Button variant="default" leftSection={<IconSquareOff size={16} />} onClick={() => run('markNoCardNext')} disabled={!can('markNoCardNext')}>
                  No card
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                {state.status}
              </Text>
            </Stack>
          </Section>
        </div>
      </div>

      <Text className={classes.hint}>
        Click: place a corner · Drag a marker: adjust · Right-drag: pan · Scroll: zoom · <Key>Enter</Key> save &amp; next ·{' '}
        <Key>N</Key> no card · <Key>S</Key> skip · <Key>←</Key>
        <Key>→</Key> browse · <Key>Ctrl+Z</Key> undo · <Key>R</Key> rotate · <Key>Del</Key> clear · <Key>E</Key> snap ·{' '}
        <Key>+</Key>
        <Key>−</Key>
        <Key>0</Key> zoom
      </Text>
    </div>
  )
}
