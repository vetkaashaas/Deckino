/**
 * Reading a card's printed name: the title strip cut from the frame, the recognizer's CTC decode, and
 * the match against the artwork model's top 5, then every card name.
 *
 * Mirrors `title_strip`, `ctc_decode`, `normalize`, `similarity` and `TitleMatcher` in the Toolbox's
 * `title_ocr.py`. `scripts/verify-title-reader.mjs` replays the export's fixture through this file, so
 * keep it free of runtime imports (Node runs it directly).
 */

import {
  homographyCoefficients,
  type CropCorner,
  type RgbImage,
} from '../artwork/recognition-crop.ts';

/** title-manifest.json's `constants` (TITLE_READER in title_ocr.py). */
export interface TitleConstants {
  card_size: number[];
  title_box: { left: number; top: number; bottom: number };
  rights: number[];
  input_height: number;
  min_line_length: number;
  top5_match: number;
  all_cards_match: number;
  rival_gap: number;
  prefix_min_length: number;
}

export type TitleMethod = 'ocr-top5' | 'ocr-all';

export interface TitleMatch {
  oracle_id: string;
  method: TitleMethod;
  score: number;
}

/**
 * The recognizer's input for one read of the title: planar (3, input_height, width) float32, BGR (the
 * model was trained on OpenCV images), scaled to [-1, 1]. Each output pixel's centre maps through the
 * card's homography into the frame and is sampled bilinearly, clamped to the frame's edge. `corners`
 * are TopLeft, TopRight, BottomRight, BottomLeft with x = pixel / (width - 1).
 */
export function titleStrip(
  image: RgbImage,
  corners: ReadonlyArray<CropCorner>,
  right: number,
  constants: TitleConstants,
): { data: Float32Array; width: number; height: number } {
  const { width, height, data } = image;
  const [cardWidth, cardHeight] = constants.card_size;
  const box = constants.title_box;
  const outHeight = constants.input_height;
  const left = box.left * cardWidth;
  const rightPx = right * cardWidth;
  const top = box.top * cardHeight;
  const bottom = box.bottom * cardHeight;
  const outWidth = Math.ceil((outHeight * (rightPx - left)) / (bottom - top));
  const [a, b, c, d, e, f, g, h] = homographyCoefficients(
    [
      [0, 0],
      [cardWidth - 1, 0],
      [cardWidth - 1, cardHeight - 1],
      [0, cardHeight - 1],
    ],
    corners.map((point) => [point.x * (width - 1), point.y * (height - 1)] as const),
  );
  const plane = width * height;
  const outPlane = outWidth * outHeight;
  const out = new Float32Array(3 * outPlane);
  for (let row = 0; row < outHeight; row += 1) {
    const cardY = top + ((row + 0.5) / outHeight) * (bottom - top) - 0.5;
    for (let column = 0; column < outWidth; column += 1) {
      const cardX = left + ((column + 0.5) / outWidth) * (rightPx - left) - 0.5;
      const denominator = g * cardX + h * cardY + 1;
      const x = Math.min(Math.max((a * cardX + b * cardY + c) / denominator, 0), width - 1);
      const y = Math.min(Math.max((d * cardX + e * cardY + f) / denominator, 0), height - 1);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const wx = x - x0;
      const wy = y - y0;
      const at = row * outWidth + column;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = channel * plane;
        const upper = data[base + y0 * width + x0] * (1 - wx) + data[base + y0 * width + x1] * wx;
        const lower = data[base + y1 * width + x0] * (1 - wx) + data[base + y1 * width + x1] * wx;
        const value = upper * (1 - wy) + lower * wy;
        // RGB in, BGR out.
        out[(2 - channel) * outPlane + at] = (value / 255 - 0.5) / 0.5;
      }
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/** Greedy CTC: class 0 is the blank, 1..n the model's characters, n + 1 a space; repeats collapse. */
export function ctcDecode(classes: ArrayLike<number>, characters: readonly string[]): string {
  let text = '';
  let previous = 0;
  for (let step = 0; step < classes.length; step += 1) {
    const index = classes[step];
    if (index !== previous && index !== 0) {
      text += index <= characters.length ? characters[index - 1] : ' ';
    }
    previous = index;
  }
  return text;
}

/** Lowercase letters and digits only: OCR merges and splits words ("k9markl"). */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 0-100: twice the longest common subsequence over both lengths (rapidfuzz's ratio). */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 100;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    const current = [0];
    for (let j = 0; j < b.length; j += 1) {
      current.push(a[i] === b[j] ? previous[j] + 1 : Math.max(previous[j + 1], current[j]));
    }
    previous = current;
  }
  return (200 * previous[b.length]) / (a.length + b.length);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** How often each of a-z, 0-9 occurs in a normalized text. */
function letterCounts(text: string): Uint8Array {
  const counts = new Uint8Array(ALPHABET.length);
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index >= 0 && counts[index] < 255) counts[index] += 1;
  }
  return counts;
}

/** Whether `similarity` can reach `score`; only skips work, never changes a result. */
function couldReach(line: string, lineCounts: Uint8Array, name: string, nameCounts: Uint8Array, score: number): boolean {
  let common = 0;
  for (let index = 0; index < lineCounts.length; index += 1) {
    common += Math.min(lineCounts[index], nameCounts[index]);
  }
  return 200 * common >= score * (line.length + name.length);
}

export interface TitleMatcher {
  match(lines: readonly string[], candidates: readonly string[]): TitleMatch | null;
}

/**
 * One of the artwork model's top 5 by name, else one card from all names. `oracleIds`/`names` are the
 * artwork labels' (app-labels.json). A card named "X // X" (an Art Series card) is left out: it repeats a
 * real card's name.
 */
export function createTitleMatcher(
  oracleIds: readonly string[],
  names: readonly string[],
  constants: TitleConstants,
): TitleMatcher {
  const faces = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  oracleIds.forEach((oracle, index) => {
    const name = names[index];
    const parts = name.split(' // ');
    if (parts.length > 1 && new Set(parts).size === 1) return;
    const own = [...new Set([name, ...parts].map(normalize).filter((face) => face.length > 0))];
    faces.set(oracle, own);
    for (const face of own) {
      const list = byName.get(face);
      if (list === undefined) byName.set(face, [oracle]);
      else list.push(oracle);
    }
  });
  // Names by length, so a read only looks at names long enough and short enough to reach a score. Sorting is
  // stable, as Python's.
  const sorted = [...byName.keys()].sort((x, y) => x.length - y.length);
  const lengths = sorted.map((name) => name.length);
  const counts = sorted.map(letterCounts);
  const sameList = (x: readonly string[] | undefined, y: readonly string[] | undefined) =>
    x !== undefined && y !== undefined && x.length === y.length && x.every((value, index) => value === y[index]);
  const firstAtLeast = (length: number) => {
    let low = 0;
    let high = lengths.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lengths[middle] < length) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  // A long enough read may also be the start of a name (glare or the frame's edge hid the rest).
  const score = (lines: readonly string[], oracle: string) => {
    let best = 0;
    for (const line of lines) {
      for (const face of faces.get(oracle) ?? []) {
        best = Math.max(best, similarity(line, face));
        if (line.length >= constants.prefix_min_length) {
          best = Math.max(best, similarity(line, face.slice(0, line.length)));
        }
      }
    }
    return best;
  };

  return {
    match(lines, candidates) {
      if (lines.length === 0) return null;
      const scored: Array<{ score: number; oracle: string }> = [];
      for (const oracle of new Set(candidates)) {
        if (faces.has(oracle)) scored.push({ score: score(lines, oracle), oracle });
      }
      if (scored.length > 0) {
        let best = scored[0];
        for (const item of scored) if (item.score > best.score) best = item; // first of equals: the artwork's order
        const rivals = scored.filter(
          (item) =>
            item.oracle !== best.oracle &&
            item.score >= best.score - constants.rival_gap &&
            !sameList(faces.get(item.oracle), faces.get(best.oracle)),
        );
        if (best.score >= constants.top5_match && rivals.length === 0) {
          return { oracle_id: best.oracle, method: 'ocr-top5', score: best.score };
        }
      }
      // All names: a short read only as an exact name (a near miss of a short name is too easy: "horder" is not
      // Order), a long one by similarity.
      const threshold = constants.all_cards_match - constants.rival_gap;
      const short = [...new Set(lines.filter((line) => line.length < constants.prefix_min_length))];
      const long = lines
        .filter((line) => line.length >= constants.prefix_min_length)
        .map((line) => ({ line, counts: letterCounts(line) }));
      const found: Array<{ score: number; name: string }> = short
        .filter((line) => byName.has(line))
        .map((line) => ({ score: 100, name: line }));
      if (long.length > 0) {
        // similarity <= 200 * min / (sum): a name shorter than lt/(200-t) or longer than l(200-t)/t can't reach t.
        const low = Math.min(...long.map(({ line }) => Math.ceil((line.length * threshold) / (200 - threshold))));
        const high = Math.max(...long.map(({ line }) => Math.floor((line.length * (200 - threshold)) / threshold)));
        for (let index = firstAtLeast(low); index < sorted.length && lengths[index] <= high; index += 1) {
          const name = sorted[index];
          let best = 0;
          for (const { line, counts: lineCounts } of long) {
            if (couldReach(line, lineCounts, name, counts[index], threshold)) {
              best = Math.max(best, similarity(line, name));
            }
          }
          if (best >= threshold && !short.includes(name)) found.push({ score: best, name });
        }
      }
      if (found.length === 0) return null;
      let best = found[0];
      for (const item of found) if (item.score > best.score) best = item;
      const oracles = byName.get(best.name) ?? [];
      const rivals = found.filter(
        (item) =>
          item.name !== best.name &&
          item.score >= best.score - constants.rival_gap &&
          !sameList(byName.get(item.name), oracles),
      );
      if (best.score < constants.all_cards_match || oracles.length !== 1 || rivals.length > 0) return null;
      return { oracle_id: oracles[0], method: 'ocr-all', score: best.score };
    },
  };
}
