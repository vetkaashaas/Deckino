import { Button, Checkbox, Group, Pagination, SegmentedControl, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconFolderOpen, IconRefresh, IconSearch, IconTrash, IconUpload } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { ref, useWorkspace } from '../bridge'
import { BoundTextInput, EmptyState, PageHeader, RetryImage } from '../components'
import classes from './pages.module.css'
import styles from './PhotoLibrary.module.css'

type Item = {
  fileName: string
  relativePath: string
  dimensions: string
  annotationStatus: string
  captureCondition: string
  thumbnailUrl: string
  isSelected: boolean
}

type PhotoLibrary = {
  displayName: string
  description: string
  pageItems: Item[]
  activeFilter: string
  searchText: string
  currentPage: number
  totalPages: number
  matchingCount: number
  selectedCount: number
  status: string
  isBusy: boolean
}

// WebView2 hands dropped files to the Toolbox with their paths (MainWindow.cs), which a page never sees.
declare global {
  interface Window {
    chrome?: { webview?: { postMessageWithAdditionalObjects: (message: string, objects: FileList) => void } }
  }
}

export default function PhotoLibraryPage() {
  const { state, can, run, set } = useWorkspace<PhotoLibrary>('photoLibrary')
  const [dragging, setDragging] = useState(false)
  const grid = useRef<HTMLDivElement>(null)

  // A new page or filter starts at the top.
  useEffect(() => {
    grid.current?.scrollTo({ top: 0 })
  }, [state?.currentPage, state?.activeFilter])

  if (!state) return null

  const drop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (state.isBusy || event.dataTransfer.files.length === 0) return
    const webview = window.chrome?.webview
    if (webview) webview.postMessageWithAdditionalObjects('import-photos', event.dataTransfer.files)
    else notifications.show({ color: 'yellow', message: 'Drop photos onto the Toolbox window to import them.' })
  }

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Button variant="subtle" color="gray" leftSection={<IconFolderOpen size={18} />} onClick={() => run('openPhotosFolder')}>
          Open photos folder
        </Button>
        <Button variant="gradient" leftSection={<IconRefresh size={18} />} onClick={() => run('refresh')} loading={state.isBusy}>
          Refresh library
        </Button>
      </PageHeader>

      <Group gap="sm" wrap="nowrap" className={classes.info}>
        <SegmentedControl
          size="xs"
          radius="xl"
          data={['All', 'Annotated', 'Unannotated']}
          value={state.activeFilter}
          onChange={(filter) => run('setFilter', filter)}
        />
        <BoundTextInput
          size="xs"
          radius="xl"
          style={{ flex: 1 }}
          leftSection={<IconSearch size={14} />}
          placeholder="Search file names (several: space or comma)"
          value={state.searchText}
          onCommit={(value) => set({ searchText: value })}
        />
        <Text size="xs" c="dimmed" truncate maw={340}>
          {state.status}
        </Text>
        <Text size="sm" fw={600} c="var(--deckino-lavender)" style={{ whiteSpace: 'nowrap' }}>
          {state.matchingCount.toLocaleString()} matching
        </Text>
        <Button size="xs" variant="subtle" onClick={() => run('selectAllMatching')} disabled={!can('selectAllMatching')}>
          Select all
        </Button>
      </Group>

      <div
        ref={grid}
        className={styles.grid}
        onDragOver={(event) => {
          event.preventDefault()
          if (!state.isBusy) setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={drop}
      >
        {state.pageItems.length === 0 ? (
          <EmptyState title="No photos match this filter" message="Drop photos or folders here to import them." />
        ) : (
          <div className={styles.tiles}>
            {state.pageItems.map((item) => (
              <div
                key={item.relativePath}
                className={styles.tile}
                role="checkbox"
                aria-checked={item.isSelected}
                aria-label={item.fileName}
                data-selected={item.isSelected || undefined}
                onClick={() => run('toggleSelected', ref('pageItems', { relativePath: item.relativePath }))}
              >
                <div className={styles.thumb}>
                  <RetryImage src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" />
                </div>
                <div className={styles.meta}>
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="sm" fw={600} truncate>
                      {item.fileName}
                    </Text>
                    <Checkbox checked={item.isSelected} readOnly size="xs" tabIndex={-1} aria-hidden style={{ pointerEvents: 'none' }} />
                  </Group>
                  <Text ff="monospace" size="xs" c="var(--deckino-dim)" truncate>
                    {item.relativePath}
                  </Text>
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="xs" truncate>
                      <span style={{ color: item.annotationStatus === 'Annotated' ? 'var(--deckino-success)' : item.annotationStatus === 'Unannotated' ? 'var(--deckino-lavender)' : 'var(--deckino-warning)' }}>
                        {item.annotationStatus}
                      </span>
                      <span style={{ color: 'var(--deckino-dim)' }}> · </span>
                      <span style={{ color: 'var(--deckino-muted)' }}>{item.captureCondition}</span>
                    </Text>
                    <Text ff="monospace" size="xs" c="var(--deckino-dim)" style={{ whiteSpace: 'nowrap' }}>
                      {item.dimensions}
                    </Text>
                  </Group>
                </div>
              </div>
            ))}
          </div>
        )}
        {dragging && (
          <div className={styles.dropHint}>
            <IconUpload size={32} />
            <Text fw={700} size="lg">
              Drop photos or folders to import them
            </Text>
          </div>
        )}
      </div>

      <Group justify="space-between" gap="sm">
        <Group gap="xs" style={{ visibility: state.selectedCount > 0 ? 'visible' : 'hidden' }}>
          <Text fw={600} size="sm" c="var(--deckino-violet)">
            {state.selectedCount.toLocaleString()} selected
          </Text>
          <Button size="xs" variant="subtle" color="gray" onClick={() => run('clearSelection')} disabled={!can('clearSelection')}>
            Clear
          </Button>
          <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={() => run('deleteAnnotations')} disabled={!can('deleteAnnotations')}>
            Delete annotations
          </Button>
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => run('deleteAnnotationsAndIdentities')}
            disabled={!can('deleteAnnotationsAndIdentities')}
          >
            Delete annotations + identities
          </Button>
          <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={() => run('deletePhotos')} disabled={!can('deletePhotos')}>
            Delete photos + annotations
          </Button>
        </Group>
        <Pagination
          size="sm"
          radius="xl"
          total={state.totalPages}
          value={state.currentPage}
          onChange={(page) => run('goToPage', page)}
          disabled={state.isBusy}
          withEdges
        />
      </Group>
    </div>
  )
}
