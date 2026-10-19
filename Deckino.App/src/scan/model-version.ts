// Which model the app runs: the one the build bundles, or a newer one downloaded since (model-store.ts). Versions are
// training runs, `<kind>-run-<UTC timestamp>`, so a later one sorts after an earlier one.

/** The downloaded version to run, or null for the bundled one (older than the build's own, or one that failed). */
export function runnableVersion(bundled: string, active: string | null, bad: readonly string[]): string | null {
  return active !== null && active > bundled && !bad.includes(active) ? active : null;
}

/**
 * What to do with the version the API names as the latest for this build's schema (null: none published, which
 * keeps what the app has). One no newer than the bundled model (a rollback) puts the app back on the bundled one.
 */
export function updateAction(
  latest: string | null,
  bundled: string,
  active: string | null,
  bad: readonly string[],
): 'download' | 'use-bundled' | 'none' {
  if (latest === null) return 'none';
  if (latest <= bundled) return active === null ? 'none' : 'use-bundled';
  return latest === active || bad.includes(latest) ? 'none' : 'download';
}
