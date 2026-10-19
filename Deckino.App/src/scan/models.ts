import { Asset } from 'expo-asset';
import { Directory, File } from 'expo-file-system';
import { Tensor, type InferenceSession } from 'onnxruntime-react-native';

import { refineCorners, type CornerRefinement } from '@/extraction/corner-refiner';
import { interpretExtractor } from '@/extraction/load-extractor';
import { createExtractorSession } from '@/extraction/session';
import type {
  ExtractionResult,
  ExtractorThresholds,
  MobileExtractorManifest,
  NormalizedPoint,
} from '@/extraction/types';
import type { ArtworkAppLabels } from '@/recognition/artwork/artwork-decision';
import {
  loadArtworkRecognizer,
  type ArtworkRecognizer,
} from '@/recognition/artwork/artwork-recognizer';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import type { ArtworkMobileManifest } from '@/recognition/artwork/types';
import manifestJson from '../../assets/models/extractor/mobile-manifest.json';
import thresholdsJson from '../../assets/models/extractor/thresholds.json';
import artworkManifestJson from '../../assets/models/artwork/mobile-manifest.json';
import artworkLabelsJson from '../../assets/models/artwork/app-labels.json';
import { downloadedModel, readModelJson, rejectDownloadedModel, type ModelKind } from './model-store';

export const EXTRACTOR_INPUT_SIZE = 320;

export interface LoadedExtractor {
  session: InferenceSession;
  delegate: string;
  manifest: MobileExtractorManifest;
  thresholds: ExtractorThresholds;
  /** The downloaded model's folder (its refiner.onnx comes from there too), or null for the bundled one. */
  files: Directory | null;
}

// The camera tab and the shared-photo page both scan; one copy of each model serves both.
let extractor: Promise<LoadedExtractor> | null = null;
let recognizer: Promise<ArtworkRecognizer> | null = null;
let refiner: Promise<{ session: InferenceSession; delegate: string }> | null = null;

/** A bundled model file's path on the phone. */
async function bundledUri(module: number, name: string): Promise<string> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) {
    throw new Error(`${name} asset has no file URI.`);
  }
  return uri;
}

/** Load the downloaded model when there is one (model-store.ts); if it won't load, the bundled one, for good. */
async function loadModel<T>(kind: ModelKind, load: (files: Directory | null) => Promise<T>): Promise<T> {
  const files = downloadedModel(kind);
  if (files === null) {
    return load(null);
  }
  try {
    return await load(files);
  } catch (error) {
    console.warn(`downloaded ${kind} model failed to load, using the bundled one`, error);
    rejectDownloadedModel(kind);
    return load(null);
  }
}

export function getExtractor(): Promise<LoadedExtractor> {
  extractor ??= loadModel('extractor', async (files) => ({
    ...(await createExtractorSession(
      files
        ? new File(files, 'extractor.onnx').uri
        : await bundledUri(require('../../assets/models/extractor/extractor.onnx'), 'Extractor ONNX'),
    )),
    manifest: files ? readModelJson(files, 'mobile-manifest.json') : (manifestJson as MobileExtractorManifest),
    thresholds: files ? readModelJson(files, 'thresholds.json') : (thresholdsJson as ExtractorThresholds),
    files,
  }));
  // A failed load is retried by the next caller.
  extractor.catch(() => {
    extractor = null;
  });
  return extractor;
}

/** Run the extractor on a letterboxed planar input and decode its corners for a width x height upright image. */
export async function runExtractor(
  { session, delegate, manifest, thresholds }: LoadedExtractor,
  pixels: Float32Array,
  width: number,
  height: number,
  resizeMs: number,
): Promise<ExtractionResult> {
  const inferStarted = Date.now();
  const results = await session.run({
    image: new Tensor('float32', pixels, [1, 3, EXTRACTOR_INPUT_SIZE, EXTRACTOR_INPUT_SIZE]),
  });
  const inferMs = Date.now() - inferStarted;
  const tensors = manifest.output_names.map((name) => {
    const value = results[name]?.data;
    return value instanceof Float32Array ? value : Float32Array.from(value as Iterable<number>);
  });
  return interpretExtractor(
    tensors,
    manifest,
    thresholds,
    width,
    height,
    { resizeMs, inferMs, decodeMs: 0, totalMs: 0 },
    delegate,
  );
}

function getRefiner(files: Directory | null): Promise<{ session: InferenceSession; delegate: string }> {
  refiner ??= (async () => {
    const uri = files
      ? new File(files, 'refiner.onnx').uri
      : await bundledUri(require('../../assets/models/extractor/refiner.onnx'), 'Refiner ONNX');
    // A small model that runs while the next extraction does: keep it to two threads.
    return createExtractorSession(uri, 2);
  })();
  // Unlike the extractor, a failed load is kept: the refiner is optional, and retrying a
  // model the device's runtime rejects would cost every recognized frame a reload.
  return refiner;
}

/** Move the extractor's corners onto the card's edge intersections with refiner.onnx (two small model runs). */
export async function refineFrameCorners(
  image: RgbImage,
  corners: NormalizedPoint[],
): Promise<CornerRefinement> {
  const { manifest, files } = await getExtractor();
  const contract = manifest.refiner;
  if (contract === null) {
    return {
      corners,
      cornerRefined: [false, false, false, false],
      cornerUncertainty: [Infinity, Infinity, Infinity, Infinity],
    };
  }
  const { session } = await getRefiner(files);
  const frame = new Tensor('uint8', image.data, [1, 3, image.height, image.width]);
  return refineCorners(
    async (cropAffine) => {
      const results = await session.run({
        frame,
        crop_affine: new Tensor('float32', cropAffine, [4, 2, 3]),
      });
      return {
        points: results.points.data as Float32Array,
        logScale: results.log_scale.data as Float32Array,
      };
    },
    corners,
    image.width,
    image.height,
    contract,
  );
}

export function getArtworkRecognizer(): Promise<ArtworkRecognizer> {
  recognizer ??= loadModel('artwork', async (files) =>
    files
      ? loadArtworkRecognizer(
          readModelJson(files, 'mobile-manifest.json'),
          readModelJson(files, 'app-labels.json'),
          new File(files, 'recognizer.onnx').uri,
        )
      : loadArtworkRecognizer(
          artworkManifestJson as ArtworkMobileManifest,
          artworkLabelsJson as ArtworkAppLabels,
          await bundledUri(require('../../assets/models/artwork/recognizer.onnx'), 'Recognizer ONNX'),
        ),
  );
  recognizer.catch(() => {
    recognizer = null;
  });
  return recognizer;
}
