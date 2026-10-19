import { useEffect, useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';

import { ApiError, getJson } from '@/api/client';
import { debugTools, usePreferences } from '@/preferences';
import artworkManifest from '../../assets/models/artwork/mobile-manifest.json';
import extractorManifest from '../../assets/models/extractor/mobile-manifest.json';
import { runnableVersion, updateAction } from './model-version';

// Newer models without an app update. The Toolbox publishes a verified model to the bucket; GET /api/models/<kind>
// names the latest one for the schema (the contract this build's code was written for) with presigned URLs, and the
// files download straight from the bucket on Wi-Fi into documents/models/<kind>-schema<n>/<version>/. A download
// is used from the next start (models load once per session); one that won't load falls back to the bundled model
// and is never used again.

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

interface ModelRelease {
  modelVersion: string;
  files: { name: string; bytes: number; md5: string; url: string }[];
}

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

// The check's progress for the scanner sheet.
let status = 'not checked yet';
const listeners = new Set<() => void>();
function setStatus(next: string) {
  status = next;
  listeners.forEach((listener) => listener());
}

export function useModelUpdateStatus(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
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
    setStatus('checking');
    checkForUpdates(controller.signal).then(
      (notes) => setStatus(notes.join(' · ')),
      (error: unknown) => {
        if (controller.signal.aborted) return; // off again, or unmounted
        console.warn('models: update check failed', error);
        setStatus(`check failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return () => controller.abort();
  }, [enabled]);
}

async function checkForUpdates(signal: AbortSignal): Promise<string[]> {
  const network = await Network.getNetworkStateAsync();
  // Mobile data could cost the user money: about 65 MB for both models.
  if (network.type !== Network.NetworkStateType.WIFI && network.type !== Network.NetworkStateType.ETHERNET) {
    return ['waiting for Wi-Fi (checked at start)'];
  }
  const notes: string[] = [];
  for (const kind of ['extractor', 'artwork'] as const) {
    const { version: bundled, schema } = BUILT[kind];
    let release: ModelRelease | null = null;
    try {
      release = await getJson<ModelRelease>(`/api/models/${kind}?schema=${schema}`, signal);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    const state = readState(kind);
    const action = updateAction(release?.modelVersion ?? null, bundled, state.active, state.bad);
    if (action === 'use-bundled') {
      writeState(kind, { ...state, active: null });
      notes.push(`${kind}: back to bundled from the next start`);
    } else if (action === 'download') {
      await download(kind, release!, signal);
      notes.push(`${kind}: ${release!.modelVersion} downloaded, used from the next start`);
    } else {
      notes.push(`${kind}: ${release === null ? 'none published' : 'up to date'}`);
    }
  }
  return notes;
}

async function download(kind: ModelKind, release: ModelRelease, signal: AbortSignal) {
  // The names become paths on the phone: only the version's own folder and the files the app loads.
  if (!/^[A-Za-z0-9_.-]+$/.test(release.modelVersion)) throw new Error(`invalid model version ${release.modelVersion}`);
  const files = BUILT[kind].files.map((name) => {
    const file = release.files.find((candidate) => candidate.name === name);
    if (file === undefined) throw new Error(`${release.modelVersion} has no ${name}`);
    return file;
  });
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const partial = new Directory(root(kind), `${release.modelVersion}.partial`);
  if (!partial.exists) partial.create({ intermediates: true });
  let done = 0;
  for (const file of files) {
    const target = new File(partial, file.name);
    // ponytail: an interrupted file starts over; a big model's partial download could resume with DownloadTask.
    if (!(target.exists && target.size === file.bytes && target.md5 === file.md5)) {
      await File.downloadFileAsync(file.url, target, {
        idempotent: true,
        signal,
        onProgress: ({ bytesWritten }) =>
          setStatus(`downloading ${kind} ${Math.floor(((done + bytesWritten) / total) * 100)}%`),
      });
      if (target.size !== file.bytes || target.md5 !== file.md5) {
        target.delete();
        throw new Error(`${file.name} of ${release.modelVersion} did not match its checksum`);
      }
    }
    done += file.bytes;
  }
  const complete = new Directory(root(kind), release.modelVersion);
  if (complete.exists) complete.delete();
  partial.rename(release.modelVersion);
  writeState(kind, { ...readState(kind), active: release.modelVersion });
  // Older downloads go, except the one this session runs (in use until the next start).
  const inUse = session.get(kind)?.version;
  for (const entry of root(kind).list()) {
    if (entry instanceof Directory && entry.name !== release.modelVersion && entry.name !== inUse) entry.delete();
  }
}
