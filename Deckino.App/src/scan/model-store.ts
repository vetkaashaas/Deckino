import { useEffect, useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';

import { ApiError, getJson } from '@/api/client';
import type * as Api from '@/api/generated';
import { debugTools, usePreferences } from '@/preferences';
import artworkManifest from '../../assets/models/artwork/mobile-manifest.json';
import extractorManifest from '../../assets/models/extractor/mobile-manifest.json';
import { runnableVersion, updateAction } from './model-version';

// Newer models without an app update. The Toolbox publishes a verified model to the bucket; GET /api/models/<kind>
// names the latest one for the schema (the contract this build's code was written for) with presigned URLs, and the
// files download straight from the bucket into documents/models/<kind>-schema<n>/<version>/. The check at start
// downloads on Wi-Fi by itself; otherwise (mobile data, Profile's refresh) a check only finds updates, and Profile
// offers each one with its size. A download is used from the next start (models load once per session); one that
// won't load falls back to the bundled model and is never used again.

export type ModelKind = 'artwork' | 'extractor';

const BUILT: Record<ModelKind, { version: string; schema: number; files: string[] }> = {
  artwork: {
    version: artworkManifest.model_version,
    schema: artworkManifest.artwork_mobile_schema_version,
    files: ['recognizer.onnx', 'app-labels.json', 'mobile-manifest.json'],
  },
  extractor: {
    version: extractorManifest.model_version,
    schema: extractorManifest.mobile_export_schema_version,
    files: ['extractor.onnx', 'refiner.onnx', 'mobile-manifest.json', 'thresholds.json'],
  },
};

type ModelRelease = Api.ModelRelease;

interface State {
  /** The newest complete download. */
  active: string | null;
  /** Downloads that would not load. */
  bad: string[];
}

const root = (kind: ModelKind) => new Directory(Paths.document, 'models', `${kind}-schema${BUILT[kind].schema}`);

function readState(kind: ModelKind): State {
  try {
    const file = new File(root(kind), 'state.json');
    if (file.exists) return { active: null, bad: [], ...(JSON.parse(file.textSync()) as Partial<State>) };
  } catch (error) {
    console.warn(`models: could not read the ${kind} state`, error);
  }
  return { active: null, bad: [] };
}

function writeState(kind: ModelKind, state: State) {
  const directory = root(kind);
  if (!directory.exists) directory.create({ intermediates: true });
  const file = new File(directory, 'state.json');
  if (!file.exists) file.create();
  file.write(JSON.stringify(state));
}

// The downloaded model each kind runs this session, decided at its first load.
const session = new Map<ModelKind, { version: string; files: Directory } | null>();

/** The downloaded model's folder to load, or null for the bundled model. */
export function downloadedModel(kind: ModelKind): Directory | null {
  if (!session.has(kind)) {
    const { active, bad } = readState(kind);
    const version = runnableVersion(BUILT[kind].version, active, bad);
    const files = version === null ? null : new Directory(root(kind), version);
    session.set(kind, files !== null && files.exists ? { version: version!, files } : null);
  }
  return session.get(kind)?.files ?? null;
}

/**
 * The version a kind runs this session, whether it came as an update (not with the app), and a newer download that
 * takes over at the next start.
 */
export function modelInfo(kind: ModelKind): { version: string; updated: boolean; next: string | null } {
  const running = downloadedModel(kind) === null ? null : session.get(kind)!.version;
  const version = running ?? BUILT[kind].version;
  const { active, bad } = readState(kind);
  const next = runnableVersion(BUILT[kind].version, active, bad);
  return { version, updated: running !== null, next: next !== null && next !== version ? next : null };
}

/** The downloaded model would not load: the bundled one takes over, and it is never used or downloaded again. */
export function rejectDownloadedModel(kind: ModelKind) {
  const rejected = session.get(kind);
  if (!rejected) return;
  session.set(kind, null);
  const state = readState(kind);
  writeState(kind, {
    active: state.active === rejected.version ? null : state.active,
    bad: [...state.bad, rejected.version],
  });
  try {
    rejected.files.delete(); // the version is never used again
  } catch (error) {
    console.warn(`models: could not delete the rejected ${kind} model`, error);
  }
}

/** A JSON file (manifest, labels, thresholds) of a downloaded model. */
export function readModelJson<T>(files: Directory, name: string): T {
  return JSON.parse(new File(files, name).textSync()) as T;
}

// The check's progress for the scanner sheet, and a copy of the updates for Profile's rows.
let status = 'not checked yet';
const listeners = new Set<() => void>();
function changed() {
  // A new copy per change: the React Compiler memoizes on identity, so rows must never see an object mutated in place.
  updates = new Map([...available].map(([kind, update]) => [kind, { ...update }]));
  listeners.forEach((listener) => listener());
}
function setStatus(next: string) {
  status = next;
  changed();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useModelUpdateStatus(): string {
  return useSyncExternalStore(subscribe, () => status);
}

/** A newer model the last check found, not downloaded yet; `progress` (0–1) while it downloads. */
export interface ModelUpdate {
  version: string;
  bytes: number;
  progress: number | null;
}

const available = new Map<ModelKind, ModelUpdate>();
let updates: ReadonlyMap<ModelKind, ModelUpdate> = new Map();

/** The update the last check found for a kind; renders again on every change (a new copy each time). */
export function useAvailableUpdate(kind: ModelKind): ModelUpdate | null {
  return useSyncExternalStore(subscribe, () => updates).get(kind) ?? null;
}

/** Wi-Fi or a cable: downloads cost the user nothing. Unknown counts as not. */
export async function onWifi(): Promise<boolean> {
  const network = await Network.getNetworkStateAsync().catch(() => null);
  return network?.type === Network.NetworkStateType.WIFI || network?.type === Network.NetworkStateType.ETHERNET;
}

async function releaseOf(kind: ModelKind, signal?: AbortSignal): Promise<ModelRelease | null> {
  try {
    return await getJson(`/api/models/${kind}?schema=${BUILT[kind].schema}`, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

// One download per kind: a second tap, or the start's check while Profile's runs, waits for the one under way.
const downloads = new Map<ModelKind, Promise<void>>();

/** Downloads the update the last check found (Profile's Update button), with fresh links: old ones expire. */
export function downloadUpdate(kind: ModelKind, signal?: AbortSignal, found?: ModelRelease): Promise<void> {
  const update = available.get(kind);
  if (update === undefined) return Promise.reject(new Error(`no ${kind} update was found`));
  const pending = downloads.get(kind);
  if (pending) return pending;
  update.progress = 0;
  changed();
  const result = (async () => {
    const release = found ?? (await releaseOf(kind, signal));
    // Only the version (and size) the check found and the user agreed to; anything newer waits for the next check.
    if (release?.modelVersion !== update.version) {
      if (available.get(kind) === update) available.delete(kind); // retrying can't help: the next check offers it
      throw new Error(`the published ${kind} model changed since the check`);
    }
    await download(kind, release, signal, (progress) => (update.progress = progress));
    if (available.get(kind) === update) available.delete(kind);
    setStatus(`${kind}: ${release.modelVersion} downloaded, used from the next start`);
  })()
    .catch((error: unknown) => {
      update.progress = null;
      // Not left on "downloading n%"; a check that started it (or was turned off) sets its own status after.
      if (signal?.aborted) changed();
      else setStatus(`${kind}: download failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    })
    .finally(() => downloads.delete(kind));
  downloads.set(kind, result);
  return result;
}

/** Checks once per start, and again when turned back on in the scanner sheet; turning it off cancels a download. */
export function useModelUpdates() {
  const { modelUpdates } = usePreferences();
  const enabled = !debugTools || modelUpdates;
  useEffect(() => {
    if (!enabled) {
      setStatus('off (scanner settings)');
      return;
    }
    const controller = new AbortController();
    void checkModelUpdates(controller.signal, true);
    return () => controller.abort();
  }, [enabled]);
}

/** What a check found: `updated` when a different model is used from the next start, `available` to download. */
export type ModelCheck = 'updated' | 'available' | 'up-to-date' | 'failed';

// One check at a time: one asked for while another runs (the start's, a second tap) waits for that one.
let running: { result: Promise<ModelCheck>; signal?: AbortSignal } | null = null;

/** Checks for newer models now (Profile's button does); `downloadOnWifi` (the start's check) also downloads them. */
export function checkModelUpdates(signal?: AbortSignal, downloadOnWifi = false): Promise<ModelCheck> {
  if (running && !running.signal?.aborted) return running.result;
  setStatus('checking');
  const result = checkForUpdates(signal, downloadOnWifi).then(
    ({ notes, check }) => {
      setStatus(notes.join(' · '));
      return check;
    },
    (error: unknown): ModelCheck => {
      if (!signal?.aborted) {
        // Turned off again, or unmounted, says nothing.
        console.warn('models: update check failed', error);
        setStatus(`check failed: ${error instanceof Error ? error.message : String(error)}`);
      } else changed(); // what it found before it stopped still reaches Profile's rows
      return 'failed';
    },
  );
  const current = { result, signal };
  running = current;
  void result.finally(() => {
    if (running === current) running = null;
  });
  return result;
}

async function checkForUpdates(
  signal: AbortSignal | undefined,
  downloadOnWifi: boolean,
): Promise<{ notes: string[]; check: ModelCheck }> {
  // Mobile data could cost the user money (about 65 MB for both models): there, Profile asks first.
  const downloadNow = downloadOnWifi && (await onWifi());
  const notes: string[] = [];
  let check: ModelCheck = 'up-to-date';
  for (const kind of ['extractor', 'artwork'] as const) {
    const release = await releaseOf(kind, signal);
    let state = readState(kind);
    const decide = () => updateAction(release?.modelVersion ?? null, BUILT[kind].version, state.active, state.bad);
    let action = decide();
    if (action !== 'download' && downloads.has(kind)) {
      // A download under way makes its version active when it ends: let it end first, or it would undo a rollback.
      await downloads.get(kind)!.catch(() => {});
      state = readState(kind);
      action = decide();
    }
    if (action === 'download') {
      // A download under way carries on (a newer version waits for the next check).
      if (!downloads.has(kind) || !available.has(kind)) {
        const bytes = releaseFiles(kind, release!).reduce((sum, file) => sum + file.bytes, 0);
        available.set(kind, { version: release!.modelVersion, bytes, progress: null });
      }
      const { version } = available.get(kind)!;
      if (downloadNow) {
        await downloadUpdate(kind, signal, release!);
        notes.push(`${kind}: ${version} downloaded, used from the next start`);
        check = 'updated';
      } else {
        notes.push(`${kind}: ${version} available`);
        if (check !== 'updated') check = 'available';
      }
      continue;
    }
    available.delete(kind);
    if (action === 'use-bundled') {
      writeState(kind, { ...state, active: null });
      notes.push(`${kind}: back to bundled from the next start`);
      check = 'updated';
    } else {
      notes.push(`${kind}: ${release === null ? 'none published' : 'up to date'}`);
    }
  }
  return { notes, check };
}

// The release's files the app loads, in BUILT's order.
function releaseFiles(kind: ModelKind, release: ModelRelease) {
  return BUILT[kind].files.map((name) => {
    const file = release.files.find((candidate) => candidate.name === name);
    if (file === undefined) throw new Error(`${release.modelVersion} has no ${name}`);
    return file;
  });
}

async function download(
  kind: ModelKind,
  release: ModelRelease,
  signal: AbortSignal | undefined,
  onProgress: (progress: number) => void,
) {
  // The names become paths on the phone: only the version's own folder and the files the app loads.
  if (!/^[A-Za-z0-9_.-]+$/.test(release.modelVersion)) throw new Error(`invalid model version ${release.modelVersion}`);
  const files = releaseFiles(kind, release);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const partial = new Directory(root(kind), `${release.modelVersion}.partial`);
  if (!partial.exists) partial.create({ intermediates: true });
  let done = 0;
  let shown = -1;
  const report = (bytes: number) => {
    // Only whole percents redraw the scanner sheet and Profile's rows (per download: both kinds can run at once).
    const percent = Math.min(100, Math.floor((bytes / total) * 100)); // a file bigger than listed fails its checksum
    if (percent === shown) return;
    shown = percent;
    onProgress(percent / 100);
    setStatus(`downloading ${kind} ${percent}%`);
  };
  for (const file of files) {
    const target = new File(partial, file.name);
    // ponytail: an interrupted file starts over; a big model's partial download could resume with DownloadTask.
    if (!(target.exists && target.size === file.bytes && target.md5 === file.md5)) {
      await File.downloadFileAsync(file.url, target, {
        idempotent: true,
        signal,
        onProgress: ({ bytesWritten }) => report(done + bytesWritten),
      });
      if (target.size !== file.bytes || target.md5 !== file.md5) {
        target.delete();
        throw new Error(`${file.name} of ${release.modelVersion} did not match its checksum`);
      }
    }
    done += file.bytes;
    report(done); // also moves on past a file a retry already has
  }
  const complete = new Directory(root(kind), release.modelVersion);
  if (complete.exists) complete.delete();
  partial.rename(release.modelVersion);
  writeState(kind, { ...readState(kind), active: release.modelVersion });
  // Older downloads go, except the one this session runs (in use until the next start).
  const inUse = session.get(kind)?.version;
  // The download is done once state.json names it: a folder that won't delete must not fail it (or offer it again).
  try {
    for (const entry of root(kind).list()) {
      if (entry instanceof Directory && entry.name !== release.modelVersion && entry.name !== inUse) entry.delete();
    }
  } catch (error) {
    console.warn(`models: could not delete an older ${kind} download`, error);
  }
}
