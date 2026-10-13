import { QueryClient } from '@tanstack/react-query';

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

// Another account's cached data must never show: drop it all whenever someone signs in or out.
let signedIn = getTokens() !== null;
subscribeSession(() => {
  if ((getTokens() !== null) !== signedIn) queryClient.clear();
  signedIn = getTokens() !== null;
});
