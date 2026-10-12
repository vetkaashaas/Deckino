/**
 * Second-stage corner refinement: moves the extractor's corners onto the point
 * where the card's straight edges meet, the convention the Toolbox labels with.
 *
 * refiner.onnx cuts the four corner crops itself (GridSample inside the graph);
 * the app supplies the frame and, per pass, one crop transform per corner, then
 * decides which refined corners to keep. Mirrors `refine_on_frame` in the
 * Toolbox's `extraction_mobile.py`: `scripts/verify-extractor-model.mjs` replays
 * the export's fixture through this file, so keep it free of runtime imports
 * (Node runs it directly).
 */
import type { NormalizedPoint } from './types';

/** The `refiner` section of the extractor's mobile-manifest.json. */
export interface RefinerContract {
  crop_size: number;
  crop_half_extent: number;
  passes: number;
  maximum_corner_uncertainty: number;
}

/** One refiner.onnx run: crop-pixel corners [4, 2] and Laplace log-scales [4]. */
export interface RefinerOutputs {
  points: ArrayLike<number>;
  logScale: ArrayLike<number>;
}

export interface CornerRefinement {
  corners: NormalizedPoint[];
  /** Which corners moved; the rest are the extractor's, unchanged. */
  cornerRefined: boolean[];
  /** Expected error per corner as a fraction of the card diagonal. */
  cornerUncertainty: number[];
}

type Point = [number, number];

interface CropFrame {
  origin: Point;
  /** Columns: one crop pixel along x, one along y, in frame pixels. */
  matrix: [Point, Point];
}

/**
 * Refine TopLeft, TopRight, BottomRight, BottomLeft corners (x = pixel / (width - 1))
 * of a width x height upright frame. `run` feeds refiner.onnx one [4, 2, 3] crop transform.
 */
export async function refineCorners(
  run: (cropAffine: Float32Array) => Promise<RefinerOutputs>,
  corners: NormalizedPoint[],
  width: number,
  height: number,
  contract: RefinerContract,
): Promise<CornerRefinement> {
  const coarse = corners.map((corner): Point => [corner.x * (width - 1), corner.y * (height - 1)]);
  const diagonal = Math.max(distance(coarse[0], coarse[2]), distance(coarse[1], coarse[3]));
  const step = (2 * contract.crop_half_extent * diagonal) / contract.crop_size;
  const unchanged = (uncertainty: number[]): CornerRefinement => ({
    corners,
    cornerRefined: [false, false, false, false],
    cornerUncertainty: uncertainty,
  });
  // The Toolbox box-reduces the photo first when a crop pixel spans 2+ frame pixels;
  // no card in a 640px frame is that big, so the phone just keeps the extractor's corners.
  if (!(step < 2)) {
    return unchanged([Infinity, Infinity, Infinity, Infinity]);
  }

  let points = coarse;
  let uncertainty = [Infinity, Infinity, Infinity, Infinity];
  for (let pass = 0; pass < contract.passes; pass += 1) {
    const frames = points.map((_, index) => cropFrame(points, index, step, contract.crop_size));
    const output = await run(cropAffine(frames, width, height));
    points = frames.map(({ origin, matrix }, index): Point => {
      const x = output.points[index * 2];
      const y = output.points[index * 2 + 1];
      return [
        origin[0] + (matrix[0][0] * x + matrix[1][0] * y),
        origin[1] + (matrix[0][1] * x + matrix[1][1] * y),
      ];
    });
    // Laplace scale in crop pixels -> fraction of the card diagonal.
    uncertainty = frames.map((_, index) => (Math.exp(output.logScale[index]) * step) / diagonal);
  }

  // Keep the extractor's corner wherever the refiner is unsure or left its crop.
  const cornerRefined = points.map(
    (point, index) =>
      distance(point, coarse[index]) / diagonal <= contract.crop_half_extent &&
      uncertainty[index] <= contract.maximum_corner_uncertainty,
  );
  const refined = corners.map((corner, index) =>
    cornerRefined[index]
      ? {
          ...corner,
          x: points[index][0] / Math.max(1, width - 1),
          y: points[index][1] / Math.max(1, height - 1),
        }
      : corner,
  );
  if (!validQuad(refined)) {
    return unchanged(uncertainty);
  }
  return { corners: refined, cornerRefined, cornerUncertainty: uncertainty };
}

/** Crop pixel q -> frame pixel origin + matrix q; the crop centre sits on the corner. */
function cropFrame(points: Point[], index: number, step: number, cropSize: number): CropFrame {
  const corner = points[index];
  const following = unit(points[(index + 1) % 4], corner);
  const previous = unit(points[(index + 3) % 4], corner);
  const matrix: [Point, Point] = [
    [following[0] * step, following[1] * step],
    [previous[0] * step, previous[1] * step],
  ];
  const centre = (cropSize - 1) / 2;
  return {
    origin: [
      corner[0] - (matrix[0][0] * centre + matrix[1][0] * centre),
      corner[1] - (matrix[0][1] * centre + matrix[1][1] * centre),
    ],
    matrix,
  };
}

/** Row-major [4, 2, 3]: crop pixel (x, y, 1) -> GridSample's normalized frame coordinates (align_corners=1). */
function cropAffine(frames: CropFrame[], width: number, height: number): Float32Array {
  const scaleX = 2 / (width - 1);
  const scaleY = 2 / (height - 1);
  const affine = new Float32Array(24);
  frames.forEach(({ origin, matrix }, index) => {
    affine.set(
      [
        matrix[0][0] * scaleX,
        matrix[1][0] * scaleX,
        origin[0] * scaleX - 1,
        matrix[0][1] * scaleY,
        matrix[1][1] * scaleY,
        origin[1] * scaleY - 1,
      ],
      index * 6,
    );
  });
  return affine;
}

/** The Toolbox's `_validate_quad`: in the frame, convex, not crossing, not tiny. */
function validQuad(corners: NormalizedPoint[]): boolean {
  if (corners.some((point) => !(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1))) {
    return false;
  }
  const turns = corners.map((a, index) => {
    const b = corners[(index + 1) % 4];
    const c = corners[(index + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  if (turns.some((turn) => Math.abs(turn) < 1e-4)) {
    return false;
  }
  if (!turns.every((turn) => turn > 0) && !turns.every((turn) => turn < 0)) {
    return false;
  }
  let twiceArea = 0;
  corners.forEach((a, index) => {
    const b = corners[(index + 1) % 4];
    twiceArea += a.x * b.y - b.x * a.y;
  });
  return Math.abs(twiceArea) / 2 >= 0.0025;
}

function unit(to: Point, from: Point): Point {
  const length = distance(to, from);
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
