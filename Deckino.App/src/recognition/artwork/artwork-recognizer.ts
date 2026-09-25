import { Asset } from 'expo-asset';
import { InferenceSession, Tensor } from 'onnxruntime-react-native';

import { createExtractorSession } from '@/extraction/session';
import type { NormalizedPoint } from '@/extraction/types';
import {
  createArtworkDecider,
  type ArtworkAppLabels,
  type ArtworkDecision,
} from './artwork-decision';
import { recognitionCrop, type RgbImage } from './recognition-crop';
import type { ArtworkMobileManifest, ArtworkTimings } from './types';

export const ARTWORK_MOBILE_SCHEMA_VERSION = 2;

export interface ArtworkRecognition {
  decision: ArtworkDecision;
  timings: ArtworkTimings;
}

export interface ArtworkRecognizer {
  modelVersion: string;
  delegate: string;
  recognize(image: RgbImage, corners: NormalizedPoint[]): Promise<ArtworkRecognition>;
}

/** Load recognizer.onnx (embedding + baked prototype search) and the bundled labels. */
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
  const size = recognizer.input_shape[2] ?? 224;
  const decide = createArtworkDecider(labels, recognizer.catalogue_size);
  const crop = new Float32Array(3 * size * size);
  const thresholds = manifest.app_decision;

  return {
    modelVersion: manifest.model_version,
    delegate,
    async recognize(image, corners) {
      const cropStarted = Date.now();
      recognitionCrop(
        image,
        corners,
        manifest.query_preprocessing.recognition_crop,
        size,
        crop,
      );
      const inferStarted = Date.now();
      const results = await run(session, recognizer.input_name, crop, size);
      const decideStarted = Date.now();
      const scores = results[recognizer.outputs.scores].data as Float32Array;
      const prototypes = results[recognizer.outputs.prototypes].data as ArrayLike<
        number | bigint
      >;
      const decision = decide(scores, prototypes, thresholds);
      return {
        decision,
        timings: {
          cropMs: inferStarted - cropStarted,
          inferMs: decideStarted - inferStarted,
          decideMs: Date.now() - decideStarted,
        },
      };
    },
  };
}

function run(
  session: InferenceSession,
  inputName: string,
  crop: Float32Array,
  size: number,
): Promise<InferenceSession.OnnxValueMapType> {
  return session.run({
    [inputName]: new Tensor('float32', crop, [1, 3, size, size]),
  });
}
