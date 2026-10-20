import { Button, Group, Loader, Modal, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import {
  IconBrain,
  IconCards,
  IconCloudDownload,
  IconDownload,
  IconFocusCentered,
  IconMovie,
  IconPackages,
  IconPhoto,
  IconRefresh,
  IconVectorTriangle,
  type Icon,
} from '@tabler/icons-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import classes from './App.module.css'
import iconWhite from './assets/icon-white.svg'
import logo from './assets/logo-original.svg'
import { answerDialog, useConnected, useWorkspace } from './bridge'
import { PageErrorBoundary } from './components'
import Annotator from './pages/Annotator'
import CardIdentification from './pages/CardIdentification'
import DatasetSync from './pages/DatasetSync'
import ExtractionTraining from './pages/ExtractionTraining'
import ModelSync from './pages/ModelSync'
import PhotoLibrary from './pages/PhotoLibrary'
import Runner from './pages/Runner'
import Sync from './pages/Sync'
import VideoImport from './pages/VideoImport'

type Shell = {
  currentKey: string
  pages: { key: string; displayName: string }[]
  versionStatus: string
  updateButtonText: string | null
}

type AppState = {
  dialogs: { id: string; title: string; message: string; accept: string; cancel: string | null }[]
  toasts: { id: string; message: string; tone: string }[]
}

const pages: Record<string, { icon: Icon; page: () => ReactNode }> = {
  sync: { icon: IconCloudDownload, page: Sync },
  datasetSync: { icon: IconRefresh, page: DatasetSync },
  modelSync: { icon: IconPackages, page: ModelSync },
  videoImport: { icon: IconMovie, page: VideoImport },
  annotator: { icon: IconVectorTriangle, page: Annotator },
  cardIdentification: { icon: IconCards, page: CardIdentification },
  photoLibrary: { icon: IconPhoto, page: PhotoLibrary },
  extractionTraining: { icon: IconFocusCentered, page: ExtractionTraining },
  runner: { icon: IconBrain, page: Runner },
}

const groups = [
  { label: 'Data', keys: ['sync', 'datasetSync', 'modelSync'] },
  { label: 'Capture', keys: ['videoImport', 'annotator', 'cardIdentification', 'photoLibrary'] },
  { label: 'Models', keys: ['extractionTraining', 'runner'] },
]

export default function App() {
  const shell = useWorkspace<Shell>('shell')
  const connected = useConnected()
  const compact = useMediaQuery('(max-width: 1180px)') ?? false

  // Files dropped anywhere but the Photo Library would make the window open them as a page.
  useEffect(() => {
    const block = (event: DragEvent) => event.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const state = shell.state
  const current = state?.currentKey
  const Page = current ? pages[current]?.page : undefined

  return (
    <div className={classes.shell} data-compact={compact || undefined}>
      <nav className={classes.sidebar}>
        <div className={classes.brand}>
          {compact ? (
            <div className={classes.mark}>
              <img src={iconWhite} alt="Deckino" />
            </div>
          ) : (
            <>
              <img src={logo} alt="Deckino" className={classes.logo} />
              <Text size="xs" c="dimmed" fw={600} className={classes.product}>
                TOOLBOX
              </Text>
            </>
          )}
        </div>

        <Stack gap="lg" className={classes.groups}>
          {groups.map((group) => (
            <Stack key={group.label} gap={2}>
              {!compact && <Text className={classes.groupLabel}>{group.label}</Text>}
              {group.keys.map((key) => {
                const entry = pages[key]
                const name = state?.pages.find((page) => page.key === key)?.displayName ?? ''
                const button = (
                  <UnstyledButton
                    key={key}
                    className={classes.navItem}
                    data-active={key === current || undefined}
                    onClick={() => key !== current && shell.run('open', key)}
                    aria-label={name}
                  >
                    <entry.icon size={20} stroke={1.7} />
                    {!compact && <span>{name}</span>}
                  </UnstyledButton>
                )
                return compact ? (
                  <Tooltip key={key} label={name} position="right">
                    {button}
                  </Tooltip>
                ) : (
                  button
                )
              })}
            </Stack>
          ))}
        </Stack>

        <Stack gap={8} className={classes.footer}>
          {state?.updateButtonText &&
            (compact ? (
              <Tooltip label={state.updateButtonText} position="right">
                <Button variant="gradient" px={0} onClick={() => shell.run('update')} disabled={!shell.can('update')}>
                  <IconDownload size={18} />
                </Button>
              </Tooltip>
            ) : (
              <Button
                variant="gradient"
                leftSection={<IconDownload size={18} />}
                onClick={() => shell.run('update')}
                disabled={!shell.can('update')}
              >
                {state.updateButtonText}
              </Button>
            ))}
          {!compact && state?.versionStatus && (
            <Text size="xs" c="var(--deckino-dim)" ta="center">
              {state.versionStatus}
            </Text>
          )}
        </Stack>
      </nav>

      <main className={classes.main}>
        {!connected && (
          <Group className={classes.offline} gap="xs" justify="center">
            <Loader size="xs" color="yellow" />
            <Text size="sm">Reconnecting to the Toolbox…</Text>
          </Group>
        )}
        {Page ? (
          <PageErrorBoundary key={current}>
            <Page />
          </PageErrorBoundary>
        ) : (
          <Loader className={classes.loading} />
        )}
      </main>

      <Dialogs />
    </div>
  )
}

// The view models' confirmations and messages, answered here; the toasts they raise.
function Dialogs() {
  const app = useWorkspace<AppState>('app')
  const shown = useRef(new Set<string>())

  useEffect(() => {
    for (const toast of app.state?.toasts ?? []) {
      if (shown.current.has(toast.id)) continue
      shown.current.add(toast.id)
      notifications.show({
        message: toast.message,
        color: toast.tone === 'error' ? 'red' : toast.tone === 'success' ? 'green' : 'purple',
      })
    }
  }, [app.state?.toasts])

  // An answered dialog closes at once, and can't be answered twice while the Toolbox catches up.
  const [answered, setAnswered] = useState(() => new Set<string>())
  const dialog = app.state?.dialogs.find((open) => !answered.has(open.id))
  const destructive = !!dialog && /delete|clear|close anyway|overwrite|discard/i.test(dialog.accept)
  // A dialog that follows another takes the focus as one opening would, not leaving it on the button just pressed.
  const body = useRef<HTMLDivElement>(null)
  const shownAt = useRef(0)
  useEffect(() => {
    shownAt.current = performance.now()
    body.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [dialog?.id])
  // Never an answer to the dialog that came next: the second click of a double-click, a held Enter (below), or a
  // close (the overlay, X or Escape) within a moment of it showing.
  const answer = (accept: boolean) => (event: React.MouseEvent | null) => {
    if (!dialog || (event?.detail ?? 0) > 1) return
    const { id } = dialog
    setAnswered((current) => new Set(current).add(id))
    // Not taken (the error is shown): the dialog comes back, as the view model is still waiting for it.
    void answerDialog(id, accept).then((taken) => {
      if (!taken)
        setAnswered((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
    })
  }
  return (
    <Modal
      opened={!!dialog}
      onClose={() => {
        if (performance.now() - shownAt.current > 400) answer(false)(null)
      }}
      title={<Text fw={700}>{dialog?.title}</Text>}
      size="lg"
    >
      {dialog && (
        <Stack
          ref={body}
          gap="lg"
          onKeyDownCapture={(event) => {
            if (event.key === 'Enter' && event.repeat) event.preventDefault()
          }}
        >
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }} data-selectable>
            {dialog.message}
          </Text>
          <Group justify="flex-end" gap="xs">
            {/* A stray Enter never confirms a deletion: those open with Cancel focused. */}
            {dialog.cancel && (
              <Button variant="default" onClick={answer(false)} data-autofocus={destructive || undefined}>
                {dialog.cancel}
              </Button>
            )}
            <Button
              variant={destructive ? 'filled' : 'gradient'}
              color={destructive ? 'red' : undefined}
              onClick={answer(true)}
              data-autofocus={!(destructive && dialog.cancel) || undefined}
            >
              {dialog.accept}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
