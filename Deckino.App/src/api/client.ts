import { useSyncExternalStore } from 'react';
import Constants from 'expo-constants';

import type { paths } from './generated';
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

// Whether the last call got no answer: the tab pages say so above what they loaded before.
let offline = false;
const offlineListeners = new Set<() => void>();
function setOffline(value: boolean) {
  if (offline === value) return;
  offline = value;
  offlineListeners.forEach((listener) => listener());
}
const subscribeOffline = (listener: () => void) => {
  offlineListeners.add(listener);
  return () => void offlineListeners.delete(listener);
};
export const useOffline = () => useSyncExternalStore(subscribeOffline, () => offline);

interface Problem {
  title?: string;
  detail?: string;
  traceId?: string; // W3C traceparent, "00-<trace id>-<span id>-00"
  errors?: Record<string, string[]>;
}

interface Options {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Calls are typed by path from generated.ts: a body or answer that no longer matches the API is a type error.
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
// A route parameter ('/api/decks/{id}') takes any value, and a call may add a query string.
type Filled<S extends string> = S extends `${infer Head}{${string}}${infer Tail}` ? `${Head}${string}${Filled<Tail>}` : S;
type Route<M extends Method> = { [K in keyof paths]: paths[K][Lowercase<M>] extends object ? K : never }[keyof paths];
type ApiPath<M extends Method> = Filled<Route<M>> | `${Filled<Route<M>>}?${string}`;
// '/api/binders/import' also fits '/api/binders/{id}', and '/api/decks/{id}/collection' fits '/api/decks/{id}': the
// most specific route wins.
type Matching<P extends string, M extends Method> = {
  [K in Route<M>]: P extends Filled<K> | `${Filled<K>}?${string}` ? K : never;
}[Route<M>];
type MostSpecific<K extends string, All extends string = K> = K extends unknown
  ? [Exclude<All extends unknown ? (Filled<All> extends Filled<K> ? All : never) : never, K>] extends [never]
    ? K
    : never
  : never;
type Operation<P extends string, M extends Method> = paths[Extract<MostSpecific<Matching<P, M>>, keyof paths>][Lowercase<M>];
type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Responses<P extends string, M extends Method> =
  Operation<P, M> extends { responses: infer R } ? { [S in keyof R]: S extends 204 ? undefined : Json<R[S]> }[keyof R] : never;
// undefined for 204 No Content; void when no answer has a body.
type Answer<P extends string, M extends Method> = [Responses<P, M>] extends [never] ? void : Responses<P, M>;
type Body<P extends string, M extends Method> = Operation<P, M> extends { requestBody?: infer R } ? Json<R> : never;
type BodyArg<P extends string, M extends Method> = [Body<P, M>] extends [never]
  ? [options?: Options]
  : [options: Options & { body: Body<P, M> }];

export function getJson<P extends ApiPath<'GET'>>(path: P, signal?: AbortSignal): Promise<Answer<P, 'GET'>> {
  return call('GET', path, { signal }) as Promise<Answer<P, 'GET'>>;
}

/** Any answer at all (the health check, which isn't in the spec): clears the offline note. */
export const ping = () => call('GET', '/api/health', {}).then(() => {}, () => {});

/** The body as it is (the export files), not parsed as JSON. */
export const getText = (path: ApiPath<'GET'>) => call('GET', path, { text: true }) as Promise<string>;

/**
 * Calls the API, signed in when there are tokens. An expired access token is refreshed once and the call retried;
 * a refused refresh (password changed, account deleted) signs the app out.
 */
export async function send<M extends Method, P extends ApiPath<M>>(
  method: M,
  path: P,
  ...[options]: BodyArg<P, M>
): Promise<Answer<P, M>> {
  return (await call(method, path, options ?? {})) as Answer<P, M>;
}

async function call(method: string, path: string, options: Options & { body?: unknown; text?: boolean }): Promise<unknown> {
  const tokens = getTokens();
  let answer = await attempt(method, path, options, tokens);
  if (answer.status === 401 && tokens && path !== '/api/auth/refresh' && (await refresh(tokens))) {
    answer = await attempt(method, path, options, getTokens());
  }
  if (answer.status < 400) return options.text ? answer.text : answer.body;

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
  { body, signal, timeoutMs = TIMEOUT_MS }: Options & { body?: unknown },
  tokens: Tokens | null,
): Promise<{ status: number; body: unknown; text: string }> {
  // The timeout covers the body too: a stalled download must not leave a screen loading forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  const unreachable = () => {
    // No answer at all; not a screen that stopped waiting, nor a slow call that timed out (a big upload).
    if (!controller.signal.aborted) setOffline(true);
    return new ApiError(0, "Can't reach Deckino. Check your connection and try again.");
  };
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
      throw unreachable();
    });
    const text = await response.text().catch(() => {
      throw unreachable();
    });
    setOffline(false);
    let parsed: unknown; // undefined for 204 No Content, as its type says
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON (a proxy's error page): the status says enough
    }
    return { status: response.status, body: parsed, text };
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
