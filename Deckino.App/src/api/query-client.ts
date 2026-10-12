import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './client';

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
