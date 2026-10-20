import { ActionIcon, Button, Group, Loader, Stack, Switch, Text, Title, Tooltip } from '@mantine/core'
import {
  IconArrowBackUp,
  IconArrowsMaximize,
  IconCheck,
  IconEraser,
  IconFolderPlus,
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
        <Button variant="subtle" color="gray" leftSection={<IconRefresh size={18} />} onClick={() => run('refresh')} disabled={state.isBusy}>
          Refresh queue
        </Button>
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
          <Group className={styles.zoom} gap={4}>
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
          <Section>
            <Stack gap={6}>
              <Title order={3} c={state.geometryIsValid ? 'var(--deckino-success)' : undefined}>
                {state.geometryStatus}
              </Title>
              {placing && (
                <Text size="sm" c="var(--deckino-violet)" fw={600}>
                  Place next: {state.nextCornerName}
                </Text>
              )}
              <Text ff="monospace" size="xs" c="var(--deckino-dim)">
                TopLeft → TopRight → BottomRight → BottomLeft
              </Text>
              <Text size="sm" c="dimmed">
                Place each point where the two straight card edges would meet, not on the rounded corner. Line up the
                dashed guides with the card's edges; exclude sleeves.
              </Text>
            </Stack>

            <Stack gap="xs" mt="md">
              <Switch
                label="Suggest corners with current model"
                checked={state.useModelSuggestions}
                onChange={(event) => set({ useModelSuggestions: event.currentTarget.checked })}
              />
              <Tooltip label="Move each confident suggestion onto the card's edges with the extractor's full-resolution corner refiner.">
                <Switch
                  label="Snap to card edges"
                  checked={state.snapSuggestions}
                  disabled={!state.useModelSuggestions}
                  onChange={(event) => set({ snapSuggestions: event.currentTarget.checked })}
                  style={{ alignSelf: 'flex-start' }}
                />
              </Tooltip>
              <Group gap={8} wrap="nowrap" align="flex-start">
                {state.isSuggesting && <Loader size={14} mt={3} />}
                <Text size="xs" c={state.suggestionIsWarning ? 'var(--deckino-warning)' : 'dimmed'}>
                  {state.suggestionStatus}
                </Text>
              </Group>
            </Stack>

            <Group grow gap={6} mt="md">
              <Button size="xs" variant="default" leftSection={<IconArrowBackUp size={14} />} onClick={() => run('undo')} disabled={!can('undo')}>
                Undo
              </Button>
              <Tooltip label="Rotate corner labels clockwise (TopLeft ← BottomLeft). Press twice if off by two.">
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconRotateClockwise size={14} />}
                  onClick={() => run('rotatePointsClockwise')}
                  disabled={!can('rotatePointsClockwise')}
                >
                  Rotate
                </Button>
              </Tooltip>
              <Tooltip label="Clear all placed points">
                <Button size="xs" variant="default" leftSection={<IconEraser size={14} />} onClick={() => run('clearPoints')} disabled={!can('clearPoints')}>
                  Clear
                </Button>
              </Tooltip>
            </Group>
            <Tooltip label="Refine the four points on the full-resolution photo with the trained corner refiner. Review the result before saving.">
              <Button
                fullWidth
                mt={6}
                size="xs"
                variant="light"
                leftSection={<IconMagnet size={14} />}
                onClick={() => run('snapToEdges')}
                disabled={!can('snapToEdges')}
              >
                Snap points now
              </Button>
            </Tooltip>
          </Section>

          <Section fill title="Perspective preview" className={styles.previewSection}>
            <ImageWell src={state.perspectivePreviewUrl} alt="The card, straightened" placeholder="Place four valid corners" fill />
          </Section>

          <Section>
            <BoundTextInput
              label="Capture condition"
              placeholder="Condition for save/import"
              value={state.captureCondition}
              onCommit={(value) => set({ captureCondition: value })}
            />
            <Stack gap={6} mt="md">
              <Button variant="gradient" size="md" leftSection={<IconCheck size={18} />} onClick={() => run('saveNext')} disabled={!can('saveNext')}>
                Save &amp; next
              </Button>
              <Group grow gap={6}>
                <Button variant="default" leftSection={<IconPlayerSkipForward size={16} />} onClick={() => run('skip')} disabled={!can('skip')}>
                  Skip
                </Button>
                <Button variant="default" leftSection={<IconSquareOff size={16} />} onClick={() => run('markNoCardNext')} disabled={!can('markNoCardNext')}>
                  No card &amp; next
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
