// Prove the app's TypeScript reproduces an artwork mobile export's fixture.
//
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-artwork-model.mjs <mobile export folder>
//
// Replays the export's crop cases through src/recognition/artwork/recognition-crop.ts
// and its top-K cases through artwork-decision.ts, then writes
// app-verification.json next to the export. Exits 1 on any mismatch.
// Run by scripts/ensure-artwork-mobile.ps1 before the model is copied into the app.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createArtworkDecider } from '../src/recognition/artwork/artwork-decision.ts';
import { recognitionCrop } from '../src/recognition/artwork/recognition-crop.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: verify-artwork-model.mjs <mobile export folder>');
  process.exit(2);
}
const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const manifest = readJson('mobile-manifest.json');
const fixture = readJson(manifest.fixture);
const labels = readJson(manifest.recognizer.labels);
const failures = [];

if (labels.model_version !== manifest.model_version) {
  failures.push(`app-labels.json is for ${labels.model_version}, manifest is ${manifest.model_version}`);
}

// Crop cases: identical sampling within float32 rounding.
const cropCases = fixture.crop_cases;
const source = cropCases.source;
const frame = new Uint8Array(readFileSync(join(root, source.file)));
const [count, channels, size] = cropCases.crops.shape;
const expectedBytes = readFileSync(join(root, cropCases.crops.file));
const expected = new Float32Array(expectedBytes.buffer, expectedBytes.byteOffset, expectedBytes.byteLength / 4);
const image = { data: frame, width: source.width, height: source.height, layout: 'interleaved' };
const cropErrors = [];
for (let index = 0; index < count; index += 1) {
  const crop = recognitionCrop(image, cropCases.corners[index],
    manifest.query_preprocessing.recognition_crop, size);
  const offset = index * channels * size * size;
  let error = 0;
  for (let pixel = 0; pixel < crop.length; pixel += 1) {
    error = Math.max(error, Math.abs(crop[pixel] - expected[offset + pixel]));
  }
  cropErrors.push(error);
  if (!(error <= cropCases.tolerance)) {
    failures.push(`crop case ${index} differs by ${error} (tolerance ${cropCases.tolerance})`);
  }
}

// Planar input (what the GPU resizer produces) must give the same crop.
const planar = new Uint8Array(frame.length);
const plane = source.width * source.height;
for (let pixel = 0; pixel < plane; pixel += 1) {
  for (let channel = 0; channel < 3; channel += 1) {
    planar[channel * plane + pixel] = frame[pixel * 3 + channel];
  }
}
const fromPlanar = recognitionCrop({ ...image, data: planar, layout: 'planar' }, cropCases.corners[0],
  manifest.query_preprocessing.recognition_crop, size);
const fromInterleaved = recognitionCrop(image, cropCases.corners[0],
  manifest.query_preprocessing.recognition_crop, size);
if (fromPlanar.some((value, index) => value !== fromInterleaved[index])) {
  failures.push('planar and interleaved frames give different crops');
}

// Top-K cases: the same decision as the exporter's decide_top_k.
const decide = createArtworkDecider(labels, manifest.recognizer.catalogue_size);
const decisionResults = fixture.top_k_cases.map((item, index) => {
  const got = decide(item.top_scores, item.top_prototypes, fixture.app_thresholds);
  const want = item.decision;
  const same = got.rejected === want.rejected
    && got.rejectionReason === want.rejection_reason
    && got.oracleId === want.oracle_id
    && got.candidate.oracleId === want.candidate_oracle_id
    && got.candidate.prototype === want.candidate_prototype
    && Math.abs(got.score - want.score) < 1e-6
    && (got.margin === null ? want.margin === null : Math.abs(got.margin - want.margin) < 1e-6)
    && got.marginIsLowerBound === want.margin_is_lower_bound
    && got.candidates.length === want.candidates.length
    && got.candidates.every((candidate, rank) => candidate.oracleId === want.candidates[rank].oracle_id);
  if (!same) {
    failures.push(`top-K case ${index}: got ${JSON.stringify({ ...got, candidates: undefined })}`);
  }
  return { case: index, oracle_id: got.oracleId, candidate: got.candidate.name, score: got.score, passed: same };
});

const report = {
  model_version: manifest.model_version,
  verified_with: 'Deckino.App src/recognition/artwork (recognition-crop.ts, artwork-decision.ts)',
  crop_max_abs_error: cropErrors,
  crop_tolerance: cropCases.tolerance,
  planar_matches_interleaved: !failures.includes('planar and interleaved frames give different crops'),
  decisions: decisionResults,
  failures,
  passed: failures.length === 0,
};
writeFileSync(join(root, 'app-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`artwork app verification ${report.passed ? 'passed' : 'FAILED'}: ` +
  `crop error ${Math.max(...cropErrors).toExponential(2)}, ` +
  `${decisionResults.filter((item) => item.passed).length}/${decisionResults.length} decisions`);
for (const failure of failures) {
  console.error(`  ${failure}`);
}
process.exit(report.passed ? 0 : 1);
