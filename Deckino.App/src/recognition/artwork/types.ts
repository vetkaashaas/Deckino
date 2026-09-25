import type { ArtworkThresholds } from './artwork-decision';
import type { RecognitionCropContract } from './recognition-crop';

/** The subset of the artwork mobile-manifest.json the app reads. */
export interface ArtworkMobileManifest {
  artwork_mobile_schema_version: number;
  model_version: string;
  dataset_version: string;
  recognizer: {
    onnx: string;
    inputs: {
      frame: { name: string };
      grid_transform: { name: string };
    };
    outputs: { embedding: string; scores: string; prototypes: string };
    top_k: number;
    catalogue_size: number;
    labels: string;
  };
  query_preprocessing: {
    recognition_crop: RecognitionCropContract;
  };
  app_decision: ArtworkThresholds & { source: string };
}

export interface ArtworkTimings {
  /** Grid transform and input tensors, in JS. */
  prepareMs: number;
  /** recognizer.onnx: crop, embedding and prototype search, native. */
  inferMs: number;
  decideMs: number;
}
