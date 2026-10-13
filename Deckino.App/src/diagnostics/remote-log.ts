import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';

import { ApiError, send } from '@/api/client';
import { getTokens } from '@/api/session';

// Builds made with EXPO_PUBLIC_REMOTE_LOG=1 send their console output to the API while
// signed in, which writes it to its own log ("AppLog" lines in Railway, with the account
// and one session id per app start). Lets us see what a tester's phone did. Signed out,
// the lines wait on the phone. console.debug is not sent.
// AppPlan Phase A10 grows this into structured logs and crash reports.

const ENABLED = process.env.EXPO_PUBLIC_REMOTE_LOG === '1';

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 200;
/** Entries kept while offline; the oldest go first. */
const MAX_BUFFERED = 1000;

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
  if (flushing || buffer.length === 0 || getTokens() === null) return;
  flushing = true;
  const batch = buffer.slice(0, MAX_BATCH);
  // The overflow trim only removes from the front, so a missing last entry means the
  // whole batch is already gone.
  const drop = () => buffer.splice(0, buffer.indexOf(batch[batch.length - 1]) + 1);
  try {
    await send('POST', '/api/app-logs', { body: { session, device: deviceLabel(), entries: batch } });
    drop();
  } catch (error) {
    // Offline, timed out, rate limited, server down or signed out meanwhile: keep the
    // batch for the next flush. Any other answer would be the same next time, so it goes.
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 0 || status === 401 || status === 429 || status >= 500) return;
    drop();
    originalWarn?.(`remote log: HTTP ${status}`);
  } finally {
    flushing = false;
  }
}

let originalWarn: ((...values: unknown[]) => void) | undefined;

/** Copy console output and uncaught JS errors to the API. Call once at startup. */
export function installRemoteLog(): void {
  if (installed || !ENABLED) return;
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
