export type CornerName = 'TopLeft' | 'TopRight' | 'BottomRight' | 'BottomLeft';

export interface NormalizedPoint {
  x: number;
  y: number;
  name: CornerName;
}

export type ExtractionRejection =
  | 'presence_below_threshold'
  | 'invalid_quadrilateral'
  | 'ambiguous_card_geometry';

export interface ExtractionTimings {
  resizeMs: number;
  inferMs: number;
  decodeMs: number;
  totalMs: number;
}

export interface ExtractionResult {
  modelVersion: string;
  corners: NormalizedPoint[] | null;
  geometryValid: boolean;
  accepted: boolean;
  rejectionReason: ExtractionRejection | null;
  presence: number;
  presenceThreshold: number;
  ambiguityMargin: number;
  candidateScore: number;
  timings: ExtractionTimings;
  delegate: string;
}

export interface LetterboxGeometry {
  inputSize: number;
  resizedWidth: number;
  resizedHeight: number;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
}

export interface GeometryOutputs {
  cornerLogits: Float32Array;
  offsets: Float32Array;
  maskLogits: Float32Array;
  orientationLogits: Float32Array;
  presenceLogits: Float32Array;
  semanticCornerLogits: Float32Array | null;
  heatmapSize: number;
}

export interface MobileExtractorManifest {
  model_version: string;
  architecture: string;
  input_shape: number[];
  input_layout: 'NCHW' | 'NHWC';
  heatmap_size: number;
  output_names: string[];
  has_semantic_corners: boolean;
  corner_anchor_policy: string;
  coordinate_transform: string;
  letterbox: string;
  tflite: string | null;
  onnx: string;
}

export interface ExtractorThresholds {
  presence_threshold: number;
  ambiguity_margin_threshold: number;
  minimum_area?: number;
}
