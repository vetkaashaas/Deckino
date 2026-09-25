/**
 * Where the artwork recognition crop comes from in the upright camera frame.
 *
 * recognizer.onnx cuts the crop itself (GridSample inside the graph); the app
 * only supplies the frame and a 3x3 grid transform built from the card corners.
 * Mirrors `recognition_grid_transform` in the Toolbox's `artwork_mobile.py`:
 * `scripts/verify-artwork-model.mjs` checks this file against the export's
 * fixture, so keep it free of runtime imports (Node runs it directly).
 */

export interface RecognitionCropContract {
  rectified_size: number[];
  canonical_pixels: { left: number; top: number; right: number; bottom: number };
}

/** An upright RGB frame, planar (RRR..GGG..BBB) as the GPU resizer writes it. */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
  layout: 'planar';
}

export interface CropCorner {
  x: number;
  y: number;
}

/** Solve the 8x8 system for the PIL-style perspective mapping destination -> source. */
export function homographyCoefficients(
  destination: ReadonlyArray<readonly [number, number]>,
  source: ReadonlyArray<readonly [number, number]>,
): number[] {
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = destination[index];
    const [u, v] = source[index];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gauss-Jordan elimination with partial pivoting on the augmented matrix.
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) {
      throw new Error('Degenerate card corners: the homography is singular.');
    }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    for (let row = 0; row < 8; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = rows[row][column] / rows[column][column];
      if (factor === 0) {
        continue;
      }
      for (let k = column; k < 9; k += 1) {
        rows[row][k] -= factor * rows[column][k];
      }
    }
  }
  return rows.map((row, index) => row[8] / row[index]);
}

/**
 * The row-major 3x3 `grid_transform` for recognizer.onnx: a homogeneous
 * rectified-card pixel (x, y, 1) -> GridSample's normalized frame coordinates
 * (align_corners: -1 is pixel 0, +1 is pixel width - 1). `corners` are the
 * extractor's normalized TopLeft, TopRight, BottomRight, BottomLeft points in
 * the upright frame, where x = pixel / (width - 1).
 */
export function recognitionGridTransform(
  corners: ReadonlyArray<CropCorner>,
  width: number,
  height: number,
  contract: RecognitionCropContract,
): number[] {
  const [rectifiedWidth, rectifiedHeight] = contract.rectified_size;
  const [a, b, c, d, e, f, g, h] = homographyCoefficients(
    [
      [0, 0],
      [rectifiedWidth - 1, 0],
      [rectifiedWidth - 1, rectifiedHeight - 1],
      [0, rectifiedHeight - 1],
    ],
    corners.map(
      (point) => [point.x * (width - 1), point.y * (height - 1)] as const,
    ),
  );
  // normalize @ homography, with normalize = [[2/(W-1), 0, -1], [0, 2/(H-1), -1], [0, 0, 1]].
  const sx = 2 / (width - 1);
  const sy = 2 / (height - 1);
  return [
    sx * a - g, sx * b - h, sx * c - 1,
    sy * d - g, sy * e - h, sy * f - 1,
    g, h, 1,
  ];
}
