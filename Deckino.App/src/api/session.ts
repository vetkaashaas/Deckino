import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';

// The signed-in account's bearer tokens (AppPlan, Authentication), kept in the Android Keystore-backed secure store
// so they survive restarts. Read once at startup, synchronously, so the first screen already knows.

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const KEY = 'deckino.tokens';
const listeners = new Set<() => void>();
let tokens = read();

function read(): Tokens | null {
  try {
    const raw = SecureStore.getItem(KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null; // unreadable after a restore to another phone: signed out
  }
}

export function getTokens(): Tokens | null {
  return tokens;
}

/** Stores a new pair (sign-in, refresh) or forgets it (sign-out, refused refresh). */
export function setTokens(next: Tokens | null): void {
  tokens = next && { accessToken: next.accessToken, refreshToken: next.refreshToken };
  try {
    // Synchronously, also when signing out (there is no sync delete; read() takes '' as none), so an app killed
    // right after Sign out can't come back signed in.
    SecureStore.setItem(KEY, tokens ? JSON.stringify(tokens) : '');
  } catch (error) {
    console.warn('session: could not store the tokens', error); // signed in until the app closes
  }
  listeners.forEach((listener) => listener());
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSignedIn(): boolean {
  return useSyncExternalStore(subscribeSession, () => tokens !== null);
}
