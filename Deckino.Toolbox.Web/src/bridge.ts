// The Toolbox's view models live in the .NET process (Deckino.Toolbox/Bridge). Each is a "workspace" addressed by name:
// its state and which commands can run come from GET /api/workspaces/{name} and the /api/events stream (the open page,
// "shell" and "app"); commands are POSTed, edits PATCHed as { "path.to.value": value }. A value { $ref: "path" }
// stands for an object already in the state; one in a list is named by its values, e.g.
// ref('runs', { 'run.modelVersion': '…' }), as its position may belong to another item by the time the server reads it.
import { notifications } from '@mantine/notifications'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

export type Ref = { $ref: string; where?: Record<string, unknown> }
export const ref = ($ref: string, where?: Record<string, unknown>): Ref => ({ $ref, where })

type Snapshot = { state: unknown; commands: Record<string, boolean> }
type Envelope = { seq: number; snapshot: Snapshot }

const snapshots = new Map<string, Envelope>()
const listeners = new Set<() => void>()
let connected = true
const connectionListeners = new Set<() => void>()

function publish(name: string, envelope: Envelope) {
  // A response and an event can cross; the newer snapshot wins.
  const current = snapshots.get(name)
  if (current && current.seq > envelope.seq) return
  snapshots.set(name, envelope)
  listeners.forEach((listener) => listener())
}

function setConnected(value: boolean) {
  if (connected === value) return
  connected = value
  connectionListeners.forEach((listener) => listener())
}

export function connect() {
  const events = new EventSource('/api/events')
  events.addEventListener('state', (event) => {
    const { name, seq, snapshot } = JSON.parse((event as MessageEvent<string>).data)
    publish(name, { seq, snapshot })
  })
  events.onopen = () => setConnected(true)
  // EventSource reconnects by itself after a dropped connection; until then the UI says so. After an error response
  // (the server restarting behind Vite, say) it gives up for good, so a new one takes over.
  events.onerror = () => {
    setConnected(events.readyState === EventSource.OPEN)
    if (events.readyState !== EventSource.CLOSED) return
    events.close()
    window.setTimeout(connect, 2000)
  }
}

const subscribeConnection = (listener: () => void) => {
  connectionListeners.add(listener)
  return () => connectionListeners.delete(listener)
}

export function useConnected() {
  return useSyncExternalStore(subscribeConnection, () => connected)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Commands and edits go one at a time, in order: a field saved as focus leaves it lands before the command of the
// button that took the focus.
let writes: Promise<unknown> = Promise.resolve()

// The reply's state, null for a success without one (204), undefined after a failure (already shown as a toast).
function send(method: string, url: string, body?: unknown): Promise<Envelope | null | undefined> {
  if (method === 'GET') return request(method, url)
  const next = writes.then(() => request(method, url, body))
  writes = next
  return next
}

async function request(method: string, url: string, body?: unknown): Promise<Envelope | null | undefined> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 204) return null
    // 409: the command can't run now; the reply still carries the current state.
    if (response.ok || response.status === 409) return (await response.json()) as Envelope
    throw new Error(
      response.status === 401
        ? 'The Toolbox did not recognise this window. Restart it.'
        : (await response.text()) || `HTTP ${response.status}`,
    )
  } catch (error) {
    notifications.show({ color: 'red', message: `Something went wrong: ${(error as Error).message}` })
    return undefined
  }
}

export type Workspace<T> = {
  state: T | undefined
  /** Whether the command can run now (its CanExecute). */
  can: (command: string) => boolean
  run: (command: string, argument?: unknown) => Promise<void>
  set: (changes: Record<string, unknown>) => Promise<void>
}

export function useWorkspace<T>(name: string): Workspace<T> {
  const envelope = useSyncExternalStore(subscribe, () => snapshots.get(name))

  // The event stream only carries the open page; a page shown again fetches its state at once.
  useEffect(() => {
    void send('GET', `/api/workspaces/${name}`).then((reply) => reply && publish(name, reply))
  }, [name])

  const run = useCallback(
    async (command: string, argument?: unknown) => {
      const reply = await send('POST', `/api/workspaces/${name}/commands/${command}`, argument ?? null)
      if (reply) publish(name, reply)
    },
    [name],
  )
  const set = useCallback(
    async (changes: Record<string, unknown>) => {
      const reply = await send('PATCH', `/api/workspaces/${name}`, changes)
      if (reply) publish(name, reply)
    },
    [name],
  )
  const commands = envelope?.snapshot.commands
  const can = useCallback((command: string) => commands?.[command] ?? false, [commands])

  return useMemo(
    () => ({ state: envelope?.snapshot.state as T | undefined, can, run, set }),
    [envelope, can, run, set],
  )
}

/** Into the Toolbox's log: what broke in the window, for a look later. */
export function reportError(error: Error, detail?: string | null) {
  // Not behind the queued writes, and no toast of its own if it fails: the page already shows the error.
  void fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: error.message, detail: [error.stack, detail].filter(Boolean).join('\n') }),
  }).catch(() => {})
}

/** Whether the Toolbox took the answer. */
export async function answerDialog(id: string, accept: boolean) {
  return (await send('POST', `/api/dialogs/${id}`, { accept })) !== undefined
}
