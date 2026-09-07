import { acceptExtraction, decodeGeometry } from './decode-geometry';
import { unletterbox } from './letterbox';
import type {
  ExtractionResult,
  ExtractorThresholds,
  GeometryOutputs,
  MobileExtractorManifest,
} from './types';

const CORNER_NAMES = [
  'TopLeft',
  'TopRight',
  'BottomRight',
  'BottomLeft',
] as const;

export function outputsFromTensors(
  tensors: Array<Float32Array | number[]>,
  manifest: MobileExtractorManifest,
): GeometryOutputs {
  'worklet';
  const byName: Record<string, Float32Array> = {};
  for (let index = 0; index < manifest.output_names.length; index += 1) {
    const tensor = tensors[index];
    byName[manifest.output_names[index]] =
      tensor instanceof Float32Array ? tensor : Float32Array.from(tensor);
  }
  return {
    cornerLogits: byName.corner_logits,
    offsets: byName.offsets,
    maskLogits: byName.mask_logits,
    orientationLogits: byName.orientation_logits,
    presenceLogits: byName.presence_logits,
    semanticCornerLogits: byName.semantic_corner_logits ?? null,
    heatmapSize: manifest.heatmap_size,
  };
}

export function interpretExtractor(
  tensors: Array<Float32Array | number[]>,
  manifest: MobileExtractorManifest,
  thresholds: ExtractorThresholds,
  frameWidth: number,
  frameHeight: number,
  timings: ExtractionResult['timings'],
  delegate: string,
): ExtractionResult {
  'worklet';
  const decodeStarted = Date.now();
  const decoded = decodeGeometry(
    outputsFromTensors(tensors, manifest),
    manifest.corner_anchor_policy,
    thresholds.presence_threshold,
  );
  const decision = acceptExtraction(
    decoded,
    thresholds.presence_threshold,
    thresholds.ambiguity_margin_threshold,
  );
  const corners =
    decoded.geometryValid
      ? unletterbox(
          decoded.corners,
          frameWidth,
          frameHeight,
          manifest.input_shape[2] ?? 320,
          manifest.coordinate_transform,
        )
      : null;
  timings.decodeMs = Date.now() - decodeStarted;
  timings.totalMs = timings.resizeMs + timings.inferMs + timings.decodeMs;
  return {
    modelVersion: manifest.model_version,
    corners:
      corners === null
        ? null
        : corners.map((point, index) => ({
            ...point,
            name: CORNER_NAMES[index],
          })),
    geometryValid: decoded.geometryValid,
    accepted: decision === 'accepted',
    rejectionReason: decision === 'accepted' ? null : decision,
    presence: decoded.presence,
    presenceThreshold: thresholds.presence_threshold,
    ambiguityMargin: decoded.ambiguityMargin,
    candidateScore: decoded.candidateScore,
    timings,
    delegate,
  };
}
