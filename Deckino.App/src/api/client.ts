import Constants from 'expo-constants';

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
  ) {
    super(message);
  }
}

interface Problem {
  title?: string;
  detail?: string;
  traceId?: string; // W3C traceparent, "00-<trace id>-<span id>-00"
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  // The timeout covers the body too: a stalled download must not leave a screen loading forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  const offline = () => new ApiError(0, "Can't reach Deckino. Check your connection and try again.");
  try {
    const response = await fetch(API_URL + path, {
      headers: { Accept: 'application/json', 'X-Deckino-App-Version': APP_VERSION },
      signal: controller.signal,
    }).catch(() => {
      throw offline();
    });
    if (response.ok) {
      return (await response.json().catch(() => {
        throw offline();
      })) as T;
    }
    const problem: Problem = await response.json().catch(() => ({}));
    if (response.status >= 500) {
      // The reference finds the request's log lines on Railway, as on the website.
      const reference = problem.traceId?.split('-')[1];
      throw new ApiError(
        response.status,
        'Something went wrong on our side. Try again in a moment.' +
          (reference ? ` If it keeps happening, contact support@deckino.com with reference ${reference}.` : ''),
      );
    }
    throw new ApiError(response.status, problem.detail ?? problem.title ?? 'Something went wrong. Try again.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
