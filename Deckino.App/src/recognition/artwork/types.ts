import type { ArtworkThresholds } from './artwork-decision';
import type { RecognitionCropContract } from './recognition-crop';

/** The subset of the artwork mobile-manifest.json the app reads. */
export interface ArtworkMobileManifest {
  artwork_mobile_schema_version: number;
  model_version: string;
  dataset_version: string;
  recognizer: {
    onnx: string;
    input_name: string;
    input_shape: number[];
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
  cropMs: number;
  inferMs: number;
  decideMs: number;
}
