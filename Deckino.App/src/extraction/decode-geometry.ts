import type { GeometryOutputs } from './types';

const TOP_K = 8;
const MINIMUM_CORNER_PEAK = 0.05;
const MINIMUM_QUAD_AREA = 0.0025;
const MINIMUM_CORNER_LOGIT = Math.log(
  MINIMUM_CORNER_PEAK / (1 - MINIMUM_CORNER_PEAK),
);
const MAXIMUM_PEAK_CANDIDATES = TOP_K * 4;
const MASK_LOGIT_THRESHOLD = 0;
const NMS_RADIUS = 2;
const POINT_IN_QUAD_EPSILON = 1e-6;
const PARALLEL_EDGE_EPSILON = 1e-12;

export const SCREEN_TOP_LEFT = 'screen-top-left-v2';
export const SCREEN_TOPMOST = 'screen-topmost-v1';

interface Peak {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
  score: number;
}

interface Candidate {
  corners: number[][];
  cells: Array<[number, number]>;
  score: number;
}

interface LocalMaximum {
  index: number;
  rawScore: number;
}

export interface DecodedGeometry {
  corners: number[];
  geometryValid: boolean;
  presence: number;
  ambiguityMargin: number;
  candidateScore: number;
}

function sigmoid(value: number): number {
  'worklet';
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function logSoftmax(values: number[]): number[] {
  'worklet';
  const max = Math.max(values[0], values[1], values[2], values[3]);
  const exps = [
    Math.exp(values[0] - max),
    Math.exp(values[1] - max),
    Math.exp(values[2] - max),
    Math.exp(values[3] - max),
  ];
  const sum = exps[0] + exps[1] + exps[2] + exps[3];
  return [
    Math.log(exps[0] / sum),
    Math.log(exps[1] / sum),
    Math.log(exps[2] / sum),
    Math.log(exps[3] / sum),
  ];
}

function softmax(values: number[]): number[] {
  'worklet';
  const max = Math.max(values[0], values[1], values[2], values[3]);
  const exps = [
    Math.exp(values[0] - max),
    Math.exp(values[1] - max),
    Math.exp(values[2] - max),
    Math.exp(values[3] - max),
  ];
  const sum = exps[0] + exps[1] + exps[2] + exps[3];
  return [exps[0] / sum, exps[1] / sum, exps[2] / sum, exps[3] / sum];
}

function clip01(value: number): number {
  'worklet';
  return Math.max(0, Math.min(1, value));
}

function atHW(buffer: Float32Array, channel: number, y: number, x: number, size: number): number {
  'worklet';
  return buffer[channel * size * size + y * size + x];
}

function screenClockwiseIndices(
  points: number[][],
  policy: string,
): number[] {
  'worklet';
  const centerX = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4;
  const centerY = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;
  const order = [0, 1, 2, 3];
  order.sort((left, right) => {
    const a = Math.atan2(points[left][1] - centerY, points[left][0] - centerX);
    const b = Math.atan2(points[right][1] - centerY, points[right][0] - centerX);
    return a - b;
  });
  const ordered = [points[order[0]], points[order[1]], points[order[2]], points[order[3]]];
  let anchor = 0;
  for (let index = 1; index < 4; index += 1) {
    const current = ordered[index];
    const best = ordered[anchor];
    if (policy === SCREEN_TOP_LEFT) {
      const currentKey = current[0] + current[1];
      const bestKey = best[0] + best[1];
      if (
        currentKey < bestKey - 1e-12 ||
        (Math.abs(currentKey - bestKey) <= 1e-12 &&
          (current[1] < best[1] - 1e-12 ||
            (Math.abs(current[1] - best[1]) <= 1e-12 && current[0] < best[0])))
      ) {
        anchor = index;
      }
    } else if (
      current[1] < best[1] - 1e-12 ||
      (Math.abs(current[1] - best[1]) <= 1e-12 && current[0] < best[0])
    ) {
      anchor = index;
    }
  }
  return [order[anchor], order[(anchor + 1) % 4], order[(anchor + 2) % 4], order[(anchor + 3) % 4]];
}

function validOrderedQuad(points: number[][]): boolean {
  'worklet';
  for (let index = 0; index < 4; index += 1) {
    const x = points[index][0];
    const y = points[index][1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) {
      return false;
    }
  }
  const edges = [
    [points[1][0] - points[0][0], points[1][1] - points[0][1]],
    [points[2][0] - points[1][0], points[2][1] - points[1][1]],
    [points[3][0] - points[2][0], points[3][1] - points[2][1]],
    [points[0][0] - points[3][0], points[0][1] - points[3][1]],
  ];
  let positive = true;
  let negative = true;
  for (let index = 0; index < 4; index += 1) {
    const next = edges[(index + 1) % 4];
    const cross = edges[index][0] * next[1] - edges[index][1] * next[0];
    if (cross <= 1e-8) {
      positive = false;
    }
    if (cross >= -1e-8) {
      negative = false;
    }
  }
  let area = 0;
  for (let index = 0; index < 4; index += 1) {
    const next = points[(index + 1) % 4];
    area += points[index][0] * next[1] - points[index][1] * next[0];
  }
  area = Math.abs(area) / 2;
  return area >= MINIMUM_QUAD_AREA && (positive || negative);
}

function pointInConvexQuad(px: number, py: number, points: number[][]): boolean {
  'worklet';
  let positive = true;
  let negative = true;
  for (let index = 0; index < 4; index += 1) {
    const ax = points[index][0];
    const ay = points[index][1];
    const bx = points[(index + 1) % 4][0];
    const by = points[(index + 1) % 4][1];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross < -POINT_IN_QUAD_EPSILON) {
      positive = false;
    }
    if (cross > POINT_IN_QUAD_EPSILON) {
      negative = false;
    }
  }
  return positive || negative;
}

function maskIou(
  points: number[][],
  maskRowPrefix: Uint16Array,
  maskCount: number,
  size: number,
): number {
  'worklet';
  const last = Math.max(1, size - 1);
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (let index = 0; index < 4; index += 1) {
    const x = points[index][0];
    const y = points[index][1];
    if (x < minX) {
      minX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y > maxY) {
      maxY = y;
    }
  }
  const x0 = Math.max(0, Math.floor(minX * last));
  const y0 = Math.max(0, Math.floor(minY * last));
  const x1 = Math.min(size - 1, Math.ceil(maxX * last));
  const y1 = Math.min(size - 1, Math.ceil(maxY * last));
  let signedArea = 0;
  for (let index = 0; index < 4; index += 1) {
    const next = points[(index + 1) % 4];
    signedArea +=
      points[index][0] * next[1] - points[index][1] * next[0];
  }
  const winding = signedArea >= 0 ? 1 : -1;
  const prefixStride = size + 1;
  let intersection = 0;
  let polygonCount = 0;
  for (let y = y0; y <= y1; y += 1) {
    const py = y / last;
    let lowerX = x0 / last;
    let upperX = x1 / last;
    let hasSpan = true;
    for (let edge = 0; edge < 4; edge += 1) {
      const ax = points[edge][0];
      const ay = points[edge][1];
      const bx = points[(edge + 1) % 4][0];
      const by = points[(edge + 1) % 4][1];
      const dx = bx - ax;
      const dy = by - ay;
      const coefficientX = winding * -dy;
      const constant = winding * (dx * py + dy * ax - dx * ay);
      if (Math.abs(coefficientX) <= PARALLEL_EDGE_EPSILON) {
        if (constant < -POINT_IN_QUAD_EPSILON) {
          hasSpan = false;
          break;
        }
        continue;
      }
      const boundary =
        (-POINT_IN_QUAD_EPSILON - constant) / coefficientX;
      if (coefficientX > 0) {
        lowerX = Math.max(lowerX, boundary);
      } else {
        upperX = Math.min(upperX, boundary);
      }
      if (lowerX > upperX) {
        hasSpan = false;
        break;
      }
    }
    if (!hasSpan) {
      continue;
    }

    // Start slightly outside the analytical interval, then use the original
    // predicate at both edges to preserve its epsilon-inclusive behaviour.
    let spanStart = Math.max(x0, Math.floor(lowerX * last) - 1);
    let spanEnd = Math.min(x1, Math.ceil(upperX * last) + 1);
    while (
      spanStart <= spanEnd &&
      !pointInConvexQuad(spanStart / last, py, points)
    ) {
      spanStart += 1;
    }
    while (
      spanEnd >= spanStart &&
      !pointInConvexQuad(spanEnd / last, py, points)
    ) {
      spanEnd -= 1;
    }
    if (spanEnd < spanStart) {
      continue;
    }

    polygonCount += spanEnd - spanStart + 1;
    const rowOffset = y * prefixStride;
    intersection +=
      maskRowPrefix[rowOffset + spanEnd + 1] -
      maskRowPrefix[rowOffset + spanStart];
  }
  const union = maskCount + polygonCount - intersection;
  return union === 0 ? 0 : intersection / union;
}

function collectPeaks(
  outputs: GeometryOutputs,
  size: number,
): Peak[] {
  'worklet';
  const count = size * size;
  let peakLogits = outputs.cornerLogits;
  if (outputs.semanticCornerLogits !== null) {
    const combined = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      let value = outputs.cornerLogits[index];
      for (let channel = 0; channel < 4; channel += 1) {
        value = Math.max(
          value,
          outputs.semanticCornerLogits[channel * count + index],
        );
      }
      combined[index] = value;
    }
    peakLogits = combined;
  }

  const localMaxima: LocalMaximum[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const value = peakLogits[index];
      if (!(value > MINIMUM_CORNER_LOGIT)) {
        continue;
      }
      let peak = true;
      for (let dy = -2; dy <= 2 && peak; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= size || nx >= size) {
            continue;
          }
          if (peakLogits[ny * size + nx] > value) {
            peak = false;
            break;
          }
        }
      }
      if (!peak) {
        continue;
      }

      let insertion = 0;
      while (
        insertion < localMaxima.length &&
        (localMaxima[insertion].rawScore > value ||
          (localMaxima[insertion].rawScore === value &&
            localMaxima[insertion].index < index))
      ) {
        insertion += 1;
      }
      if (insertion < MAXIMUM_PEAK_CANDIDATES) {
        localMaxima.splice(insertion, 0, { index, rawScore: value });
        if (localMaxima.length > MAXIMUM_PEAK_CANDIDATES) {
          localMaxima.pop();
        }
      }
    }
  }

  const peaks: Peak[] = [];
  for (
    let candidateIndex = 0;
    candidateIndex < localMaxima.length && peaks.length < TOP_K;
    candidateIndex += 1
  ) {
    const maximum = localMaxima[candidateIndex];
    const cellY = Math.floor(maximum.index / size);
    const cellX = maximum.index % size;
    let tooClose = false;
    for (let index = 0; index < peaks.length; index += 1) {
      if (
        Math.max(Math.abs(cellX - peaks[index].cellX), Math.abs(cellY - peaks[index].cellY)) <=
        NMS_RADIUS
      ) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      continue;
    }
    const offsetX = Math.max(-0.5, Math.min(0.5, atHW(outputs.offsets, 0, cellY, cellX, size)));
    const offsetY = Math.max(-0.5, Math.min(0.5, atHW(outputs.offsets, 1, cellY, cellX, size)));
    peaks.push({
      x: clip01((cellX + offsetX) / (size - 1)),
      y: clip01((cellY + offsetY) / (size - 1)),
      cellX,
      cellY,
      // The previous decoder stored probabilities in Float32Array before
      // candidate scoring. Keep that rounding so thresholds remain stable.
      score: Math.fround(sigmoid(maximum.rawScore)),
    });
  }
  return peaks;
}

export function decodeGeometry(
  outputs: GeometryOutputs,
  cornerAnchorPolicy: string,
  minimumPresence = 0,
): DecodedGeometry {
  'worklet';
  const size = outputs.heatmapSize;
  const presence = sigmoid(outputs.presenceLogits[0]);
  if (presence < minimumPresence) {
    return {
      corners: [0, 0, 0, 0, 0, 0, 0, 0],
      geometryValid: false,
      presence,
      ambiguityMargin: -1e9,
      candidateScore: -1e9,
    };
  }
  const peaks = collectPeaks(outputs, size);
  const prefixStride = size + 1;
  const maskRowPrefix = new Uint16Array(size * prefixStride);
  let maskCount = 0;
  for (let y = 0; y < size; y += 1) {
    const maskOffset = y * size;
    const prefixOffset = y * prefixStride;
    let rowCount = 0;
    for (let x = 0; x < size; x += 1) {
      if (outputs.maskLogits[maskOffset + x] >= MASK_LOGIT_THRESHOLD) {
        rowCount += 1;
        maskCount += 1;
      }
      maskRowPrefix[prefixOffset + x + 1] = rowCount;
    }
  }
  let bestCandidate: Candidate | null = null;
  let secondBestScore = -Infinity;
  let candidateCount = 0;
  for (let a = 0; a < peaks.length; a += 1) {
    for (let b = a + 1; b < peaks.length; b += 1) {
      for (let c = b + 1; c < peaks.length; c += 1) {
        for (let d = c + 1; d < peaks.length; d += 1) {
          const group = [peaks[a], peaks[b], peaks[c], peaks[d]];
          const unordered = [
            [group[0].x, group[0].y],
            [group[1].x, group[1].y],
            [group[2].x, group[2].y],
            [group[3].x, group[3].y],
          ];
          const order = screenClockwiseIndices(unordered, cornerAnchorPolicy);
          const points = [
            unordered[order[0]],
            unordered[order[1]],
            unordered[order[2]],
            unordered[order[3]],
          ];
          if (!validOrderedQuad(points)) {
            continue;
          }
          const first = group[order[0]];
          const second = group[order[1]];
          const third = group[order[2]];
          const fourth = group[order[3]];
          const iou = maskIou(points, maskRowPrefix, maskCount, size);
          const meanLog =
            (Math.log(Math.max(first.score, 1e-8)) +
              Math.log(Math.max(second.score, 1e-8)) +
              Math.log(Math.max(third.score, 1e-8)) +
              Math.log(Math.max(fourth.score, 1e-8))) /
            4;
          const candidateScore = meanLog + 2 * iou;
          candidateCount += 1;
          if (bestCandidate === null || candidateScore > bestCandidate.score) {
            if (bestCandidate !== null) {
              secondBestScore = bestCandidate.score;
            }
            bestCandidate = {
              corners: points,
              cells: [
                [first.cellX, first.cellY],
                [second.cellX, second.cellY],
                [third.cellX, third.cellY],
                [fourth.cellX, fourth.cellY],
              ],
              score: candidateScore,
            };
          } else if (candidateScore > secondBestScore) {
            secondBestScore = candidateScore;
          }
        }
      }
    }
  }
  if (bestCandidate === null) {
    return {
      corners: [0, 0, 0, 0, 0, 0, 0, 0],
      geometryValid: false,
      presence,
      ambiguityMargin: -1e9,
      candidateScore: -1e9,
    };
  }
  const selected = bestCandidate;
  let orientation = 0;
  for (let index = 1; index < 4; index += 1) {
    if (
      outputs.orientationLogits[index] >
      outputs.orientationLogits[orientation]
    ) {
      orientation = index;
    }
  }
  let semanticMargin = 1e9;
  if (outputs.semanticCornerLogits !== null) {
    const orientationScores = logSoftmax([
      outputs.orientationLogits[0],
      outputs.orientationLogits[1],
      outputs.orientationLogits[2],
      outputs.orientationLogits[3],
    ]);
    const semanticScores = [0, 0, 0, 0];
    for (let role = 0; role < 4; role += 1) {
      let sum = 0;
      for (let index = 0; index < 4; index += 1) {
        const channel = (index - role + 4) % 4;
        const x = selected.cells[index][0];
        const y = selected.cells[index][1];
        const logits = [
          atHW(outputs.semanticCornerLogits, 0, y, x, size),
          atHW(outputs.semanticCornerLogits, 1, y, x, size),
          atHW(outputs.semanticCornerLogits, 2, y, x, size),
          atHW(outputs.semanticCornerLogits, 3, y, x, size),
        ];
        sum += logSoftmax(logits)[channel];
      }
      semanticScores[role] = sum / 4 + 0.5 * orientationScores[role];
    }
    orientation = 0;
    for (let index = 1; index < 4; index += 1) {
      if (semanticScores[index] > semanticScores[orientation]) {
        orientation = index;
      }
    }
    const ranked = [semanticScores[0], semanticScores[1], semanticScores[2], semanticScores[3]];
    ranked.sort((left, right) => right - left);
    semanticMargin = ranked[0] - ranked[1];
  }
  const rotated = selected.corners
    .slice(orientation)
    .concat(selected.corners.slice(0, orientation));
  const geometryMargin =
    candidateCount > 1 ? selected.score - secondBestScore : 1e9;
  return {
    corners: [
      rotated[0][0],
      rotated[0][1],
      rotated[1][0],
      rotated[1][1],
      rotated[2][0],
      rotated[2][1],
      rotated[3][0],
      rotated[3][1],
    ],
    geometryValid: true,
    presence,
    ambiguityMargin: Math.min(geometryMargin, semanticMargin),
    candidateScore: selected.score,
  };
}

export function acceptExtraction(
  decoded: DecodedGeometry,
  presenceThreshold: number,
  ambiguityThreshold: number,
): 'accepted' | 'presence_below_threshold' | 'invalid_quadrilateral' | 'ambiguous_card_geometry' {
  'worklet';
  if (decoded.presence < presenceThreshold) {
    return 'presence_below_threshold';
  }
  if (!decoded.geometryValid) {
    return 'invalid_quadrilateral';
  }
  if (decoded.ambiguityMargin < ambiguityThreshold) {
    return 'ambiguous_card_geometry';
  }
  return 'accepted';
}

export { softmax };
