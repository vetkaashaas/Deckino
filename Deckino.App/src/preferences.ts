import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';

import { getTokens, subscribeSession } from '@/api/session';

// The app's settings, kept on the phone like the website keeps its currency in the browser (AppPlan, Phase A3).
// Read synchronously at startup, so the first screen already uses them.

export interface Preferences {
  currency: 'usd' | 'eur';
  /** Where scans are saved (A5); null asks each time. */
  defaultBinderId: string | null;
  /** Set while scanning into a deck (A6) or the wishlist (A7): the tray goes there instead of the binder. */
  scanTo: ScanTo;
  condition: (typeof CONDITIONS)[number]['value'];
  language: (typeof LANGUAGES)[number]['value'];
  finish: 'nonfoil' | 'foil';
  haptics: boolean;
  scanSound: boolean;
  /** Help improve recognition: upload scans while signed in. On until the store release (A11) makes it opt-in. */
  trainingPhotos: boolean;
  /** Whether the signed-in user has answered the question about it (/help-improve); nothing uploads before. */
  trainingPhotosAsked: boolean;
  /** "Not now" on the welcome screen; cleared by signing in, so it shows again after signing out. */
  welcomeSeen: boolean;
}

export type ScanTo = { kind: 'deck'; id: string } | { kind: 'wishlist' } | null;

// The API's values (BinderEndpoints.Conditions, Languages) with the website's labels.
export const CONDITIONS = [
  { value: 'NM', label: 'Near Mint' },
  { value: 'LP', label: 'Lightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'HP', label: 'Heavily Played' },
  { value: 'DMG', label: 'Damaged' },
] as const;

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ru', label: 'Russian' },
  { value: 'zhs', label: 'Simplified Chinese' },
  { value: 'zht', label: 'Traditional Chinese' },
  { value: 'ph', label: 'Phyrexian' },
] as const;

export type ChoiceKey = 'currency' | 'defaultBinderId' | 'condition' | 'language' | 'finish';

export const CHOICES: Record<ChoiceKey, { title: string; options: { value: string | null; label: string }[] }> = {
  currency: {
    title: 'Currency',
    options: [
      { value: 'usd', label: 'US dollar ($)' },
      { value: 'eur', label: 'Euro (€)' },
    ],
  },
  defaultBinderId: { title: 'Default binder', options: [{ value: null, label: 'Ask each time' }] }, // + the binders
  condition: { title: 'Condition', options: [...CONDITIONS] },
  language: { title: 'Language', options: [...LANGUAGES] },
  finish: {
    title: 'Finish',
    options: [
      { value: 'nonfoil', label: 'Non-foil' },
      { value: 'foil', label: 'Foil' },
    ],
  },
};

/** The label of a preference's current value, for its row in Profile. */
export function choiceLabel(key: ChoiceKey, preferences: Preferences, binders?: { id: string; name: string }[]) {
  if (key === 'defaultBinderId' && preferences.defaultBinderId !== null) {
    return binders?.find((b) => b.id === preferences.defaultBinderId)?.name ?? 'Ask each time';
  }
  return CHOICES[key].options.find((option) => option.value === preferences[key])?.label ?? '';
}

const DEFAULTS: Preferences = {
  currency: 'usd',
  defaultBinderId: null,
  scanTo: null,
  condition: 'NM',
  language: 'en',
  finish: 'nonfoil',
  haptics: true,
  scanSound: true,
  trainingPhotos: true,
  trainingPhotosAsked: false,
  welcomeSeen: false,
};

const KEY = 'deckino.preferences';
const listeners = new Set<() => void>();
let current = read();

function read(): Preferences {
  try {
    const raw = SecureStore.getItem(KEY);
    // Settings added in later versions take their defaults.
    return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Preferences>) : {}) };
  } catch {
    return DEFAULTS;
  }
}

export function getPreferences(): Preferences {
  return current;
}

export function setPreferences(change: Partial<Preferences>): void {
  current = { ...current, ...change };
  try {
    SecureStore.setItem(KEY, JSON.stringify(current));
  } catch (error) {
    console.warn('preferences: could not save', error); // kept until the app closes
  }
  listeners.forEach((listener) => listener());
}

// The training-photos answer belongs to the account that gave it: after a sign-out, whoever signs in next is asked.
// The welcome screen's "Not now" lasts until a sign-in, so signing out shows it again. Also checked at load, in case
// the session changed before this module was.
function followSession() {
  if (getTokens() === null && current.trainingPhotosAsked) {
    setPreferences({ trainingPhotos: DEFAULTS.trainingPhotos, trainingPhotosAsked: false });
  }
  if (getTokens() !== null && current.welcomeSeen) setPreferences({ welcomeSeen: false });
}
followSession();
subscribeSession(followSession);

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
