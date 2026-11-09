// Prove the app's TypeScript reads card titles exactly as the Toolbox's title_ocr.py.
//
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-title-reader.mjs <title reader export folder>
//
// Replays the export's fixture (written by `deckino_training export-title-reader`) through
// src/recognition/title/title-core.ts: the title strip cut from a test frame (corner order, homography
// direction, pixel centres, edge clamping, BGR order, scaling, strip width), the CTC decode, the name
// similarity and the top-5 / all-cards match. Exits 1 on any mismatch.
// Run by scripts/ensure-title-reader.ps1 before the reader is copied into the app.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createTitleMatcher,
  ctcDecode,
  similarity,
  titleStrip,
} from '../src/recognition/title/title-core.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: verify-title-reader.mjs <title reader export folder>');
  process.exit(2);
}
const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const manifest = readJson('title-manifest.json');
const fixture = readJson(manifest.fixture);
const characters = readJson(manifest.characters);
const constants = manifest.constants;
const failures = [];

// The test frame, built from the same formula as _fixture_frame in title_ocr.py: planar RGB.
const { width, height } = fixture.frame;
const plane = width * height;
const data = new Uint8Array(3 * plane);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      data[channel * plane + y * width + x] = (x * 31 + y * 17 + channel * 71 + ((x * y) % 13)) % 256;
    }
  }
}
const image = { data, width, height, layout: 'planar' };

let worstStrip = 0;
fixture.strip_cases.forEach((item, index) => {
  const strip = titleStrip(image, item.corners, item.right, constants);
  const shape = [3, strip.height, strip.width];
  if (shape.join() !== item.shape.join()) {
    failures.push(`strip case ${index}: shape ${shape} != ${item.shape}`);
    return;
  }
  let sum = 0;
  let squares = 0;
  for (const value of strip.data) {
    sum += value;
    squares += value * value;
  }
  const size = strip.data.length;
  const errors = [
    Math.abs(sum - item.sum) / size,
    Math.abs(squares - item.sum_of_squares) / size,
    ...item.samples.map(([at, value]) => Math.abs(strip.data[at] - value)),
  ];
  const error = Math.max(...errors);
  worstStrip = Math.max(worstStrip, error);
  if (!(error <= fixture.tolerance)) failures.push(`strip case ${index} differs by ${error}`);
});

fixture.decode_cases.forEach((item, index) => {
  const text = ctcDecode(item.classes, characters);
  if (text !== item.text) failures.push(`decode case ${index}: "${text}" != "${item.text}"`);
});

fixture.similarity_cases.forEach((item) => {
  const score = similarity(item.a, item.b);
  if (Math.abs(score - item.score) > 1e-9) failures.push(`similarity("${item.a}", "${item.b}") ${score} != ${item.score}`);
});

const matcher = createTitleMatcher(fixture.oracle_ids, fixture.names, constants);
fixture.match_cases.forEach((item, index) => {
  const got = matcher.match(item.lines, item.candidates);
  const want = item.result;
  const same =
    (got === null && want === null) ||
    (got !== null &&
      want !== null &&
      got.oracle_id === want.oracle_id &&
      got.method === want.method &&
      Math.abs(got.score - want.score) < 1e-9);
  if (!same) failures.push(`match case ${index} (${item.lines}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
});

console.log(
  `title reader: ${fixture.strip_cases.length} strips (worst ${worstStrip.toExponential(2)}), ` +
    `${fixture.decode_cases.length} decodes, ${fixture.similarity_cases.length} similarities, ` +
    `${fixture.match_cases.length} matches`,
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('title reader: the app matches the Toolbox');
