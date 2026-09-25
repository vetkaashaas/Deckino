import { Asset } from 'expo-asset';
import { Tensor } from 'onnxruntime-react-native';

import { createExtractorSession } from '@/extraction/session';
import type { NormalizedPoint } from '@/extraction/types';
import {
  createArtworkDecider,
  type ArtworkAppLabels,
  type ArtworkDecision,
} from './artwork-decision';
import { recognitionGridTransform, type RgbImage } from './recognition-crop';
import type { ArtworkMobileManifest, ArtworkTimings } from './types';

// Must match MOBILE_SCHEMA_VERSION in the Toolbox's artwork_mobile.py and
// $RequiredSchema in scripts/ensure-artwork-mobile.ps1.
export const ARTWORK_MOBILE_SCHEMA_VERSION = 3;

export interface ArtworkRecognition {
  decision: ArtworkDecision;
  timings: ArtworkTimings;
}

export interface ArtworkRecognizer {
  modelVersion: string;
  delegate: string;
  recognize(image: RgbImage, corners: NormalizedPoint[]): Promise<ArtworkRecognition>;
}

/** Load recognizer.onnx (crop + embedding + baked prototype search) and the bundled labels. */
export async function loadArtworkRecognizer(
  manifest: ArtworkMobileManifest,
  labels: ArtworkAppLabels,
  modelModule: number,
): Promise<ArtworkRecognizer> {
  if (manifest.artwork_mobile_schema_version !== ARTWORK_MOBILE_SCHEMA_VERSION) {
    throw new Error(
      `artwork export schema v${manifest.artwork_mobile_schema_version}, app needs v${ARTWORK_MOBILE_SCHEMA_VERSION}`,
    );
  }
  if (labels.model_version !== manifest.model_version) {
    throw new Error(
      `app-labels.json is for ${labels.model_version}, manifest is ${manifest.model_version}`,
    );
  }
  const asset = Asset.fromModule(modelModule);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) {
    throw new Error('Recognizer ONNX asset has no file URI.');
  }
  const { session, delegate } = await createExtractorSession(uri);
  const recognizer = manifest.recognizer;
  const decide = createArtworkDecider(labels, recognizer.catalogue_size);
  const thresholds = manifest.app_decision;

  return {
    modelVersion: manifest.model_version,
    delegate,
    async recognize(image, corners) {
      const prepareStarted = Date.now();
      const transform = Float32Array.from(
        recognitionGridTransform(
          corners,
          image.width,
          image.height,
          manifest.query_preprocessing.recognition_crop,
        ),
      );
      const feeds = {
        [recognizer.inputs.frame.name]: new Tensor('uint8', image.data, [
          1,
          3,
          image.height,
          image.width,
        ]),
        [recognizer.inputs.grid_transform.name]: new Tensor('float32', transform, [3, 3]),
      };
      const inferStarted = Date.now();
      const results = await session.run(feeds);
      const decideStarted = Date.now();
      const scores = results[recognizer.outputs.scores].data as Float32Array;
      const prototypes = results[recognizer.outputs.prototypes].data as ArrayLike<
        number | bigint
      >;
      const decision = decide(scores, prototypes, thresholds);
      return {
        decision,
        timings: {
          prepareMs: inferStarted - prepareStarted,
          inferMs: decideStarted - inferStarted,
          decideMs: Date.now() - decideStarted,
        },
      };
    },
  };
}
