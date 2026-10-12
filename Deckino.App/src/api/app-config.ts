import { useQuery } from '@tanstack/react-query';

import { APP_VERSION, getJson } from './client';

interface AppConfig {
  minimumVersion: string;
}

/** Negative, zero or positive, comparing "major.minor.patch" numerically. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True once the API says this build is too old. Offline or unknown counts as supported. */
export function useUpdateRequired(): boolean {
  const { data } = useQuery({
    queryKey: ['app-config'],
    queryFn: ({ signal }) => getJson<AppConfig>('/api/app/config', signal),
    staleTime: 60 * 60 * 1000,
  });
  return data !== undefined && compareVersions(APP_VERSION, data.minimumVersion) < 0;
}
