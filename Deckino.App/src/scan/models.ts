import { Asset } from 'expo-asset';
import { Tensor, type InferenceSession } from 'onnxruntime-react-native';

import { interpretExtractor } from '@/extraction/load-extractor';
import { createExtractorSession } from '@/extraction/session';
import type {
  ExtractionResult,
  ExtractorThresholds,
  MobileExtractorManifest,
} from '@/extraction/types';
import type { ArtworkAppLabels } from '@/recognition/artwork/artwork-decision';
import {
  loadArtworkRecognizer,
  type ArtworkRecognizer,
} from '@/recognition/artwork/artwork-recognizer';
import type { ArtworkMobileManifest } from '@/recognition/artwork/types';
import manifestJson from '../../assets/models/extractor/mobile-manifest.json';
import thresholdsJson from '../../assets/models/extractor/thresholds.json';
import artworkManifestJson from '../../assets/models/artwork/mobile-manifest.json';
import artworkLabelsJson from '../../assets/models/artwork/app-labels.json';

export const extractorManifest = manifestJson as MobileExtractorManifest;
export const extractorThresholds = thresholdsJson as ExtractorThresholds;
export const EXTRACTOR_INPUT_SIZE = 320;

export interface LoadedExtractor {
  session: InferenceSession;
  delegate: string;
}

// The camera tab and the shared-photo page both scan; one copy of each model serves both.
let extractor: Promise<LoadedExtractor> | null = null;
let recognizer: Promise<ArtworkRecognizer> | null = null;

export function getExtractor(): Promise<LoadedExtractor> {
  extractor ??= (async () => {
    const asset = Asset.fromModule(
      require('../../assets/models/extractor/extractor.onnx'),
    );
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    if (!uri) {
      throw new Error('Extractor ONNX asset has no file URI.');
    }
    return createExtractorSession(uri);
  })();
  // A failed load is retried by the next caller.
  extractor.catch(() => {
    extractor = null;
  });
  return extractor;
}

/** Run the extractor on a letterboxed planar input and decode its corners for a width x height upright image. */
export async function runExtractor(
  { session, delegate }: LoadedExtractor,
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
  const tensors = extractorManifest.output_names.map((name) => {
    const value = results[name]?.data;
    return value instanceof Float32Array ? value : Float32Array.from(value as Iterable<number>);
  });
  return interpretExtractor(
    tensors,
    extractorManifest,
    extractorThresholds,
    width,
    height,
    { resizeMs, inferMs, decodeMs: 0, totalMs: 0 },
    delegate,
  );
}

export function getArtworkRecognizer(): Promise<ArtworkRecognizer> {
  recognizer ??= loadArtworkRecognizer(
    artworkManifestJson as ArtworkMobileManifest,
    artworkLabelsJson as ArtworkAppLabels,
    require('../../assets/models/artwork/recognizer.onnx'),
  );
  recognizer.catch(() => {
    recognizer = null;
  });
  return recognizer;
}
