import Constants from 'expo-constants';

import { getTokens, setTokens, type Tokens } from './session';

// The API this build talks to: https://deckino.com unless the build sets EXPO_PUBLIC_API_URL (a local API in dev
// builds, the E2E API in test builds).
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'https://deckino.com').replace(/\/$/, '');
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

/** React Native's Android HTTP client never times out on its own. */
const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(
    readonly status: number, // 0: no answer (offline, timeout)
    message: string,
    /** A validation problem's messages by field (`email`, `password`…). */
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

interface Problem {
  title?: string;
  detail?: string;
  traceId?: string; // W3C traceparent, "00-<trace id>-<span id>-00"
  errors?: Record<string, string[]>;
}

interface Options {
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return send<T>('GET', path, { signal });
}

/**
 * Calls the API, signed in when there are tokens. An expired access token is refreshed once and the call retried;
 * a refused refresh (password changed, account deleted) signs the app out.
 */
export async function send<T>(method: string, path: string, options: Options = {}): Promise<T> {
  const tokens = getTokens();
  let answer = await attempt(method, path, options, tokens);
  if (answer.status === 401 && tokens && path !== '/api/auth/refresh' && (await refresh(tokens))) {
    answer = await attempt(method, path, options, getTokens());
  }
  if (answer.status < 400) return answer.body as T;

  const problem = (answer.body ?? {}) as Problem;
  if (answer.status >= 500) {
    // The reference finds the request's log lines on Railway, as on the website.
    const reference = problem.traceId?.split('-')[1];
    throw new ApiError(
      answer.status,
      'Something went wrong on our side. Try again in a moment.' +
        (reference ? ` If it keeps happening, contact support@deckino.com with reference ${reference}.` : ''),
    );
  }
  const fields = problem.errors ?? {};
  const first = Object.values(fields)[0]?.[0];
  throw new ApiError(answer.status, problem.detail ?? first ?? problem.title ?? 'Something went wrong. Try again.', fields);
}

async function attempt(
  method: string,
  path: string,
  { body, signal, timeoutMs = TIMEOUT_MS }: Options,
  tokens: Tokens | null,
): Promise<{ status: number; body: unknown }> {
  // The timeout covers the body too: a stalled download must not leave a screen loading forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  const offline = () => new ApiError(0, "Can't reach Deckino. Check your connection and try again.");
  try {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Deckino-App-Version': APP_VERSION };
    if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(API_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => {
      throw offline();
    });
    const text = await response.text().catch(() => {
      throw offline();
    });
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (a proxy's error page): the status says enough
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

// One refresh at a time: the calls that failed together all wait for it.
let refreshing: Promise<boolean> | null = null;

function refresh(stale: Tokens): Promise<boolean> {
  if (getTokens() !== stale) return Promise.resolve(getTokens() !== null); // another call already refreshed
  refreshing ??= (async () => {
    try {
      const answer = await attempt('POST', '/api/auth/refresh', { body: { refreshToken: stale.refreshToken } }, null);
      // Signed out (or in again) while it ran: that wins.
      if (getTokens() !== stale) return getTokens() !== null;
      if (answer.status === 200) setTokens(answer.body as Tokens);
      else if (answer.status === 401) setTokens(null);
      return answer.status === 200;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
