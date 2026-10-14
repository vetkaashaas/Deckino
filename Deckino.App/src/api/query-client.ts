import { AppState } from 'react-native';
import { focusManager, QueryClient } from '@tanstack/react-query';

import { ApiError } from './client';
import { getTokens, subscribeSession } from './session';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // the catalogue changes once a day
      // Retry only what can succeed on a second try: no answer, or a server error.
      retry: (failures, error) =>
        failures < 2 && error instanceof ApiError && (error.status === 0 || error.status >= 500),
    },
  },
});

// Back in the app is React Query's "window focus": what has gone stale refetches.
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener('change', (state) => setFocused(state === 'active'));
  return () => subscription.remove();
});

// Another account's cached data must never show: drop it all whenever someone signs in or out.
let signedIn = getTokens() !== null;
subscribeSession(() => {
  if ((getTokens() !== null) !== signedIn) queryClient.clear();
  signedIn = getTokens() !== null;
});
