/**
 * The artwork recognition crop, cut straight from the upright camera frame.
 *
 * Mirrors `phone_recognition_crop` in the Toolbox's `artwork_mobile.py` exactly:
 * recognition_crop_v1 of the 315x440 rectified card, stretched to 224x224, with
 * the rectify and the resize composed into one homography + bilinear sample.
 * `scripts/verify-artwork-model.mjs` checks this file against the export's
 * fixture, so keep it free of runtime imports (Node runs it directly).
 */

export interface RecognitionCropContract {
  rectified_size: number[];
  canonical_pixels: { left: number; top: number; right: number; bottom: number };
}

export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** 'planar' = RRR..GGG..BBB (the GPU resizer), 'interleaved' = RGBRGB.. */
  layout: 'planar' | 'interleaved';
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
  // Gaussian elimination with partial pivoting on the augmented matrix.
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
 * Cut the [3, size, size] float32 [0, 1] recognition crop from `image`.
 * `corners` are the extractor's normalized TopLeft, TopRight, BottomRight,
 * BottomLeft points in the upright frame, where x = pixel / (width - 1).
 */
export function recognitionCrop(
  image: RgbImage,
  corners: ReadonlyArray<CropCorner>,
  contract: RecognitionCropContract,
  size: number,
  output?: Float32Array,
): Float32Array {
  const { width, height, data } = image;
  const [rectifiedWidth, rectifiedHeight] = contract.rectified_size;
  const box = contract.canonical_pixels;
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
  const plane = size * size;
  const pixels = output ?? new Float32Array(plane * 3);
  const channelStride = image.layout === 'planar' ? width * height : 1;
  const pixelStride = image.layout === 'planar' ? 1 : 3;
  const spanX = box.right - box.left;
  const spanY = box.bottom - box.top;
  const maxX = width - 1;
  const maxY = height - 1;

  for (let row = 0; row < size; row += 1) {
    const canonicalY = box.top + ((row + 0.5) / size) * spanY - 0.5;
    for (let column = 0; column < size; column += 1) {
      const canonicalX = box.left + ((column + 0.5) / size) * spanX - 0.5;
      const denominator = g * canonicalX + h * canonicalY + 1;
      let sampleX = (a * canonicalX + b * canonicalY + c) / denominator;
      let sampleY = (d * canonicalX + e * canonicalY + f) / denominator;
      sampleX = sampleX < 0 ? 0 : sampleX > maxX ? maxX : sampleX;
      sampleY = sampleY < 0 ? 0 : sampleY > maxY ? maxY : sampleY;
      const left = Math.floor(sampleX);
      const top = Math.floor(sampleY);
      const right = left + 1 > maxX ? maxX : left + 1;
      const bottom = top + 1 > maxY ? maxY : top + 1;
      const weightX = sampleX - left;
      const weightY = sampleY - top;
      const topLeft = (top * width + left) * pixelStride;
      const topRight = (top * width + right) * pixelStride;
      const bottomLeft = (bottom * width + left) * pixelStride;
      const bottomRight = (bottom * width + right) * pixelStride;
      const target = row * size + column;
      for (let channel = 0; channel < 3; channel += 1) {
        const offset = channel * channelStride;
        const upper =
          data[topLeft + offset] * (1 - weightX) +
          data[topRight + offset] * weightX;
        const lower =
          data[bottomLeft + offset] * (1 - weightX) +
          data[bottomRight + offset] * weightX;
        pixels[channel * plane + target] =
          (upper * (1 - weightY) + lower * weightY) / 255;
      }
    }
  }
  return pixels;
}
