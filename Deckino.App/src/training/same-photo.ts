import type { NormalizedPoint } from '@/extraction/types';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';

// "Is this the photo we already sent?" A camera left on a card (or a rig) sends the same frame every few seconds.
// The card is compared, not the whole frame: in a rig the card is small, so two different cards in the same spot
// look alike as whole frames. Tuned on the 4,706 phone scans up to 2026-11-14 (scratch script, same rule): it
// found every repeat of a card left in view and never joined two different cards.

/** A corner moving more than this (fraction of the frame) means the card was moved: a new photo. */
const SAME_PLACE = 0.02;
const GRID_X = 12;
const GRID_Y = 16;
/** A block whose average brightness changed by more than this (0-255) has changed... */
const BLOCK_DIFF = 16;
/** ...and more changed blocks than this makes it another photo (glare or a hand over one corner stays the same). */
const MAX_CHANGED_BLOCKS = 4;

export interface PhotoPrint {
  corners: NormalizedPoint[];
  /** Average brightness of each block of the card's bounding box, rows top to bottom. */
  blocks: Float32Array;
}

export function maxMotion(a: NormalizedPoint[], b: NormalizedPoint[]): number {
  let max = Number.POSITIVE_INFINITY;
  if (a.length === b.length) {
    max = 0;
    for (const corner of a) {
      const other = b.find((point) => point.name === corner.name);
      if (other === undefined) return Number.POSITIVE_INFINITY;
      max = Math.max(max, Math.hypot(corner.x - other.x, corner.y - other.y));
    }
  }
  return max;
}

/** Null when the card's box is too small to compare (then it is always a new photo). */
export function photoPrint(image: RgbImage, corners: NormalizedPoint[]): PhotoPrint | null {
  const { data, width, height } = image;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const xs = corners.map((corner) => clamp(corner.x));
  const ys = corners.map((corner) => clamp(corner.y));
  const x0 = Math.floor(Math.min(...xs) * width);
  const x1 = Math.floor(Math.max(...xs) * width);
  const y0 = Math.floor(Math.min(...ys) * height);
  const y1 = Math.floor(Math.max(...ys) * height);
  if (x1 - x0 < GRID_X || y1 - y0 < GRID_Y) return null;
  const pixels = width * height;
  const blocks = new Float32Array(GRID_X * GRID_Y);
  for (let gy = 0; gy < GRID_Y; gy += 1) {
    const top = y0 + Math.floor(((y1 - y0) * gy) / GRID_Y);
    const bottom = y0 + Math.floor(((y1 - y0) * (gy + 1)) / GRID_Y);
    for (let gx = 0; gx < GRID_X; gx += 1) {
      const left = x0 + Math.floor(((x1 - x0) * gx) / GRID_X);
      const right = x0 + Math.floor(((x1 - x0) * (gx + 1)) / GRID_X);
      let sum = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let index = y * width + left; index < y * width + right; index += 1) {
          sum += data[index] + 2 * data[pixels + index] + data[2 * pixels + index];
        }
      }
      blocks[gy * GRID_X + gx] = sum / 4 / ((bottom - top) * (right - left));
    }
  }
  return { corners, blocks };
}

export function samePhoto(a: PhotoPrint, b: PhotoPrint): boolean {
  if (maxMotion(a.corners, b.corners) >= SAME_PLACE) return false;
  let changed = 0;
  for (let index = 0; index < a.blocks.length; index += 1) {
    if (Math.abs(a.blocks[index] - b.blocks[index]) > BLOCK_DIFF && ++changed > MAX_CHANGED_BLOCKS) return false;
  }
  return true;
}
