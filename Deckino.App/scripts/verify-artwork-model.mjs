// Prove the app's TypeScript reproduces an artwork mobile export's fixture.
//
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-artwork-model.mjs <mobile export folder>
//
// Replays the export's grid cases through src/recognition/artwork/recognition-crop.ts
// and its top-K cases through artwork-decision.ts, then writes
// app-verification.json next to the export. Exits 1 on any mismatch.
// Run by scripts/ensure-artwork-mobile.ps1 before the model is copied into the app.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createArtworkDecider } from '../src/recognition/artwork/artwork-decision.ts';
import { recognitionGridTransform } from '../src/recognition/artwork/recognition-crop.ts';

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

// Grid cases: the 3x3 transform the app feeds recognizer.onnx (the graph does the sampling;
// the export already checked that sampling against the reference crop).
const gridErrors = fixture.grid_cases.map((item, index) => {
  const got = recognitionGridTransform(item.corners, item.width, item.height,
    manifest.query_preprocessing.recognition_crop);
  const error = Math.max(...got.map((value, cell) =>
    Math.abs(value - item.grid_transform[cell]) / Math.max(1, Math.abs(item.grid_transform[cell]))));
  if (!(error <= fixture.grid_tolerance)) {
    failures.push(`grid case ${index} (${item.width}x${item.height}) differs by ${error}`);
  }
  return error;
});

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
  grid_max_relative_error: gridErrors,
  grid_tolerance: fixture.grid_tolerance,
  decisions: decisionResults,
  failures,
  passed: failures.length === 0,
};
writeFileSync(join(root, 'app-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`artwork app verification ${report.passed ? 'passed' : 'FAILED'}: ` +
  `grid error ${Math.max(...gridErrors).toExponential(2)} over ${gridErrors.length} cases, ` +
  `${decisionResults.filter((item) => item.passed).length}/${decisionResults.length} decisions`);
for (const failure of failures) {
  console.error(`  ${failure}`);
}
process.exit(report.passed ? 0 : 1);
