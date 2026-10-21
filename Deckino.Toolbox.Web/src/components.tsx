import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Progress,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  type TextInputProps,
} from '@mantine/core'
import {
  IconClearAll,
  IconClipboardCopy,
  IconCopy,
  IconFolderOpen,
  IconPhoto,
  IconPlayerStop,
} from '@tabler/icons-react'
import { Component, useEffect, useRef, useState, type ErrorInfo, type ImgHTMLAttributes, type ReactNode } from 'react'
import { reportError } from './bridge'
import classes from './components.module.css'

export type Tone = 'Neutral' | 'Pending' | 'Accent' | 'Success' | 'Warning' | 'Danger'

export const toneColor: Record<Tone, string> = {
  Neutral: 'var(--deckino-muted)',
  Pending: 'var(--deckino-dim)',
  Accent: 'var(--deckino-violet)',
  Success: 'var(--deckino-success)',
  Warning: 'var(--deckino-warning)',
  Danger: 'var(--deckino-danger)',
}

/** A stage's or step's status (ProductionStageStatus, StatusKind, RequirementState) as a tone. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'Running':
    case 'Working':
      return 'Accent'
    case 'Passed':
    case 'Done':
      return 'Success'
    case 'Warning':
      return 'Warning'
    case 'Failed':
    case 'Missing':
      return 'Danger'
    case 'Cancelled':
      return 'Neutral'
    default:
      return 'Pending'
  }
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={classes.dot} data-pulse={pulse || undefined} style={{ background: toneColor[tone] }} />
}

/**
 * A job's start button, which becomes its Cancel button while the job runs. Both labels are laid over each other, so
 * the button keeps the wider one's size and nothing beside it moves.
 */
export function RunButton({
  busy,
  icon,
  label,
  onRun,
  runDisabled,
  onCancel,
  cancelDisabled,
}: {
  busy: boolean
  icon: ReactNode
  label: string
  onRun: () => void
  runDisabled?: boolean
  onCancel: () => void
  cancelDisabled?: boolean
}) {
  return (
    <Button
      variant={busy ? 'light' : 'gradient'}
      color={busy ? 'red' : undefined}
      bd="none" // light has a 1px border, gradient none: without this Cancel is 2px bigger
      onClick={busy ? onCancel : onRun}
      disabled={busy ? cancelDisabled : runDisabled}
    >
      <span className={classes.swap}>
        <Group gap={8} wrap="nowrap" data-hidden={busy || undefined} aria-hidden={busy || undefined}>
          {icon}
          {label}
        </Group>
        <Group gap={8} wrap="nowrap" justify="center" data-hidden={!busy || undefined} aria-hidden={!busy || undefined}>
          <IconPlayerStop size={18} />
          Cancel
        </Group>
      </span>
    </Button>
  )
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      size="lg"
      leftSection={<Dot tone={tone} pulse={tone === 'Accent'} />}
      styles={{ root: { color: toneColor[tone], borderColor: 'rgba(255, 255, 255, 0.12)', background: 'var(--deckino-glass)' } }}
    >
      {children}
    </Badge>
  )
}

export function PageHeader({
  title,
  subtitle,
  status,
  children,
}: {
  title: string
  subtitle?: string
  status?: ReactNode
  children?: ReactNode
}) {
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap={4} miw={0}>
        <Group gap="sm" wrap="nowrap">
          <Title order={1}>{title}</Title>
          {status}
        </Group>
        {subtitle && (
          <Text c="dimmed" size="sm" maw={720}>
            {subtitle}
          </Text>
        )}
      </Stack>
      <Group gap="xs" wrap="wrap" justify="flex-end">
        {children}
      </Group>
    </Group>
  )
}

/** A glass card with an optional title, subtitle and actions on the right. */
export function Section({
  title,
  subtitle,
  actions,
  children,
  className,
  fill,
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** Takes the height its parent gives it; the content scrolls inside. */
  fill?: boolean
}) {
  return (
    <Card className={`${classes.section} ${className ?? ''}`} data-fill={fill || undefined}>
      {(title || actions) && (
        <Group justify="space-between" align="flex-start" wrap="nowrap" mb="md" gap="sm">
          <Stack gap={2} miw={0}>
            {title && <Title order={3}>{title}</Title>}
            {subtitle && (
              <Text c="dimmed" size="sm">
                {subtitle}
              </Text>
            )}
          </Stack>
          {actions && (
            <Group gap="xs" wrap="nowrap">
              {actions}
            </Group>
          )}
        </Group>
      )}
      {children}
    </Card>
  )
}

export function StatTile({ label, value, caption }: { label: string; value: ReactNode; caption?: string }) {
  return (
    <div className={classes.stat}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      <Text className={classes.statValue}>{value}</Text>
      {caption && (
        <Text size="xs" c="var(--deckino-dim)" truncate>
          {caption}
        </Text>
      )}
    </div>
  )
}

export type Stage = {
  id?: string
  name: string
  status: string
  detail: string
  duration?: string
  progressPercent?: number
  showsProgress?: boolean
}

export function StageList({ stages }: { stages: Stage[] }) {
  return (
    <Stack gap={0}>
      {stages.map((stage) => {
        const tone = statusTone(stage.status)
        return (
          <div key={stage.id ?? stage.name} className={classes.stage}>
            <Group gap="sm" wrap="nowrap" justify="space-between">
              <Group gap="sm" wrap="nowrap" miw={0}>
                <Dot tone={tone} pulse={tone === 'Accent'} />
                <Text fw={600} size="sm" truncate>
                  {stage.name}
                </Text>
              </Group>
              {stage.duration && (
                <Text ff="monospace" size="xs" c="dimmed">
                  {stage.duration}
                </Text>
              )}
            </Group>
            <Text size="sm" c="dimmed" pl={22} data-selectable>
              {stage.detail}
            </Text>
            {stage.showsProgress && <Progress value={stage.progressPercent ?? 0} size="sm" ml={22} mt={6} animated />}
          </div>
        )
      })}
    </Stack>
  )
}

/** The activity log: follows the newest line unless scrolled up; a click selects a line to copy. */
export function LogPanel({
  lines,
  selected,
  onSelect,
  onOpenFolder,
  onClear,
  onCopySelected,
  onCopyAll,
  title = 'Activity log',
}: {
  lines: string[]
  selected: string | null
  onSelect: (line: string) => void
  onOpenFolder?: () => void
  onClear?: () => void
  onCopySelected?: () => void
  onCopyAll?: () => void
  title?: string
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    const element = viewport.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [lines])

  const action = (label: string, icon: ReactNode, onClick?: () => void, disabled?: boolean) =>
    onClick && (
      <Tooltip label={label}>
        <ActionIcon variant="subtle" color="gray" onClick={onClick} disabled={disabled} aria-label={label}>
          {icon}
        </ActionIcon>
      </Tooltip>
    )

  return (
    <Section
      fill
      title={title}
      actions={
        <>
          {action('Copy selected line', <IconCopy size={18} />, onCopySelected, !selected)}
          {action('Copy the whole log', <IconClipboardCopy size={18} />, onCopyAll, lines.length === 0)}
          {action('Open the log folder', <IconFolderOpen size={18} />, onOpenFolder)}
          {action('Clear this view (the log file keeps everything)', <IconClearAll size={18} />, onClear, lines.length === 0)}
        </>
      }
    >
      <ScrollArea
        className={classes.log}
        viewportRef={viewport}
        onScrollPositionChange={({ y }) => {
          const element = viewport.current
          if (element) following.current = y + element.clientHeight >= element.scrollHeight - 24
        }}
      >
        {lines.length === 0 ? (
          <Text size="sm" c="var(--deckino-dim)" p="sm">
            Nothing logged yet.
          </Text>
        ) : (
          lines.map((line, index) => (
            <div
              key={index}
              className={classes.logLine}
              data-selected={line === selected || undefined}
              onClick={() => onSelect(line)}
              data-selectable
            >
              {line}
            </div>
          ))
        )}
      </ScrollArea>
    </Section>
  )
}

export function EmptyState({ icon, title, message }: { icon?: ReactNode; title: string; message?: string }) {
  return (
    <Stack align="center" justify="center" gap={6} py="xl" className={classes.empty}>
      <div className={classes.emptyIcon}>{icon ?? <IconPhoto size={22} />}</div>
      <Text fw={600}>{title}</Text>
      {message && (
        <Text size="sm" c="dimmed" ta="center" maw={360}>
          {message}
        </Text>
      )}
    </Stack>
  )
}

/**
 * A page that fails to render shows what happened and a way back, instead of blanking the window (whose reload keys
 * are off outside development).
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <Stack align="center" justify="center" h="100%" gap="md">
        <EmptyState title="This page ran into a problem" message={this.state.error.message} />
        <Button variant="gradient" onClick={() => window.location.reload()}>
          Reload the Toolbox window
        </Button>
      </Stack>
    )
  }
}

/** An image in a dark well, or a quiet placeholder while there is none. */
export function ImageWell({
  src,
  alt,
  placeholder,
  height,
  aspect,
  fill,
  retry,
}: {
  src: string | null | undefined
  alt: string
  placeholder?: string
  height?: number | string
  aspect?: string
  /** Takes the rest of a filled Section's height. */
  fill?: boolean
  /** An image that may not exist yet (useImageRetry). */
  retry?: boolean
}) {
  // While the image fails (a card image not downloaded yet) the placeholder shows.
  const image = useImageRetry(src, retry)
  return (
    <Box className={classes.well} style={{ height, aspectRatio: aspect, flex: fill ? '1 1 0' : undefined, minHeight: fill ? 120 : undefined }}>
      {image.url && !image.failed ? (
        <img src={image.url} alt={alt} className={classes.wellImage} onError={image.onError} />
      ) : (
        <Text size="sm" c="var(--deckino-dim)" ta="center" px="md">
          {placeholder ?? 'No image yet'}
        </Text>
      )}
    </Box>
  )
}

/**
 * An image that may fail: while it does, it says so. With `retry` (an image that may not exist yet, a card image
 * Scryfall Sync is still downloading) it is asked for again until it shows, a little later each time, up to a minute.
 */
export function useImageRetry(src: string | null | undefined, retry = false) {
  const [state, setState] = useState({ src, attempt: 0, failed: false })
  // Another image starts afresh, and so does one shown again later (React redoes this render at once).
  if (state.src !== src) setState({ src, attempt: 0, failed: false })
  useEffect(() => {
    if (!retry || !state.failed) return
    const timer = window.setTimeout(
      () => setState({ src, attempt: state.attempt + 1, failed: false }),
      Math.min(60_000, 5_000 * 2 ** state.attempt),
    )
    return () => window.clearTimeout(timer)
  }, [src, retry, state.failed, state.attempt])
  return {
    url: src && state.attempt > 0 ? `${src}${src.includes('?') ? '&' : '?'}retry=${state.attempt}` : src,
    failed: state.failed,
    onError: () => setState({ src, attempt: state.attempt, failed: true }),
  }
}

/** An <img> that stays hidden while it fails (useImageRetry). */
export function RetryImage({
  src,
  retry,
  style,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & { src: string; retry?: boolean }) {
  const image = useImageRetry(src, retry)
  return <img {...props} src={image.url ?? undefined} onError={image.onError} style={{ ...style, visibility: image.failed ? 'hidden' : undefined }} />
}

/**
 * A photo that ticks on and off with a click, or with Space or Enter once tabbed to. Its name and tick sit under it,
 * then any further caption. A tick highlights it, or with `dimUnticked` (a list kept unless left out) an untick dims it.
 */
export function PhotoTile({
  src,
  name,
  checked,
  onToggle,
  dimUnticked,
  retry,
  disabled,
  children,
}: {
  src: string
  name: string
  checked: boolean
  onToggle: () => void
  dimUnticked?: boolean
  /** A photo that may be missing for a moment (useImageRetry). */
  retry?: boolean
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={classes.tile}
      role="checkbox"
      aria-checked={checked}
      aria-label={name}
      aria-disabled={disabled || undefined}
      tabIndex={0}
      data-selected={(!dimUnticked && checked) || undefined}
      data-dimmed={(dimUnticked && !checked) || undefined}
      onClick={disabled ? undefined : onToggle}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        // A held key ticks once.
        if (!event.repeat && !disabled) onToggle()
      }}
    >
      <div className={classes.thumb}>
        <RetryImage src={src} retry={retry} alt="" loading="lazy" decoding="async" />
      </div>
      <div className={classes.meta}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" fw={600} truncate c={dimUnticked && !checked ? 'var(--deckino-dim)' : undefined}>
            {name}
          </Text>
          <Checkbox checked={checked} readOnly size="xs" tabIndex={-1} aria-hidden style={{ pointerEvents: 'none' }} />
        </Group>
        {children}
      </div>
    </div>
  )
}

/**
 * Text bound to a view model property: typing updates the field at once and the view model shortly after; while
 * the field has focus, the view model's value never overwrites what is being typed.
 */
export function BoundTextInput({
  value,
  onCommit,
  delay = 300,
  ...props
}: Omit<TextInputProps, 'value' | 'onChange'> & { value: string; onCommit: (value: string) => void; delay?: number }) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <TextInput
      {...props}
      value={draft}
      onChange={(event) => {
        const next = event.currentTarget.value
        setDraft(next)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => onCommit(next), delay)
      }}
      onFocus={(event) => {
        focused.current = true
        props.onFocus?.(event)
      }}
      onBlur={(event) => {
        focused.current = false
        window.clearTimeout(timer.current)
        if (draft !== value) onCommit(draft)
        props.onBlur?.(event)
      }}
    />
  )
}

/** True when a key press belongs to a text field or an open dialog, not to a page shortcut. */
export function isTyping(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  // A switch or checkbox keeps the focus after a click; it is no text field.
  return (
    !!target?.closest('input:not([type="checkbox"], [type="radio"], [type="button"]), textarea, select, [contenteditable="true"]') ||
    !!document.querySelector('[role="dialog"][aria-modal]')
  )
}
