import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';

import { UPLOAD_KEY, UPLOAD_URL } from '@/training/training-upload';

// TEMPORARY, like the training uploads: builds made with the upload URL and key send
// their console output to the API, which writes it to its own log ("AppLog" lines in
// Railway, one session id per app start). Lets us see what a tester's phone did.
// console.debug is not sent: keep per-frame output there.

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 200;
/** Entries kept while offline; the oldest go first. */
const MAX_BUFFERED = 1000;
const UPLOAD_TIMEOUT_MS = 15000;

type Level = 'log' | 'warn' | 'error';
interface Entry {
  time: number;
  level: Level;
  message: string;
}

const session = Math.random().toString(36).slice(2, 10);
const buffer: Entry[] = [];
let flushing = false;
let installed = false;

function deviceLabel(): string {
  const constants = Platform.constants as Record<string, unknown>;
  const model =
    Platform.OS === 'android'
      ? `${String(constants.Manufacturer)} ${String(constants.Model)} Android ${String(Platform.Version)}`
      : `iOS ${String(Platform.Version)}`;
  return `${model} · app ${Constants.expoConfig?.version ?? '?'}${__DEV__ ? ' dev' : ''}`;
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Queue a line for upload (console.* calls land here too once installed). */
export function remoteLog(level: Level, ...values: unknown[]): void {
  if (!installed) return;
  buffer.push({ time: Date.now(), level, message: values.map(format).join(' ') });
  if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.slice(0, MAX_BATCH);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${UPLOAD_URL}/api/dev/app-logs`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', 'X-Deckino-Upload-Key': UPLOAD_KEY! },
      body: JSON.stringify({ session, device: deviceLabel(), entries: batch }),
    });
    // Rate limited or server down: keep the batch for the next flush. Any other answer
    // would be the same next time, so the batch goes. The overflow trim only removes
    // from the front, so a missing last entry means the whole batch is already gone.
    if (response.status === 429 || response.status >= 500) return;
    buffer.splice(0, buffer.indexOf(batch[batch.length - 1]) + 1);
    if (!response.ok) originalWarn?.(`remote log: HTTP ${response.status}`);
  } catch {
    // Offline or timed out: the entries stay buffered for the next flush.
  } finally {
    clearTimeout(timeout);
    flushing = false;
  }
}

let originalWarn: ((...values: unknown[]) => void) | undefined;

/** Copy console output and uncaught JS errors to the API. Call once at startup. */
export function installRemoteLog(): void {
  if (installed || !UPLOAD_URL || !UPLOAD_KEY) return;
  installed = true;
  originalWarn = console.warn.bind(console);
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      original(...values);
      remoteLog(level === 'info' ? 'log' : level, ...values);
    };
  }
  const previousHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    remoteLog('error', `uncaught${isFatal ? ' fatal' : ''}:`, error);
    // A fatal error closes the app before the next interval flush.
    if (isFatal) void flush();
    previousHandler(error, isFatal);
  });
  setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  AppState.addEventListener('change', (state) => {
    remoteLog('log', `app state: ${state}`);
    if (state !== 'active') void flush();
  });
  remoteLog('log', `app start: ${deviceLabel()}`);
}
