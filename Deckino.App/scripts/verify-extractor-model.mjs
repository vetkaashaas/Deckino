// Prove the app's TypeScript reproduces an extractor mobile export's refiner fixture.
//
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-extractor-model.mjs <mobile export folder>
//
// Replays every fixture card through src/extraction/corner-refiner.ts, feeding it the
// refiner outputs the exporter recorded: each pass's crop transforms must match what
// the exporter fed refiner.onnx, and the kept corners must match its refine_on_frame.
// Writes app-verification.json next to the export; exits 1 on any mismatch.
// Run by scripts/ensure-extraction-mobile.ps1 before the model is copied into the app.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { refineCorners } from '../src/extraction/corner-refiner.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: verify-extractor-model.mjs <mobile export folder>');
  process.exit(2);
}
const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const manifest = readJson('mobile-manifest.json');
const failures = [];
const names = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
let affineError = 0;
let cornerError = 0;
let uncertaintyError = 0;

if (manifest.refiner === null || manifest.refiner === undefined) {
  failures.push('the export has no refiner; the app expects refiner.onnx');
} else {
  const fixture = readJson(manifest.refiner.fixture);
  for (const [index, item] of fixture.cases.entries()) {
    let pass = 0;
    const run = async (affine) => {
      const recorded = item.passes[pass];
      pass += 1;
      if (recorded === undefined) {
        throw new Error(`case ${index}: ran more passes than the exporter`);
      }
      affineError = Math.max(affineError, ...recorded.crop_affine.map((value, cell) => Math.abs(affine[cell] - value)));
      return { points: recorded.points, logScale: recorded.log_scale };
    };
    const corners = item.corners.map((point, corner) => ({ ...point, name: names[corner] }));
    const got = await refineCorners(run, corners, fixture.width, fixture.height, manifest.refiner);
    const want = item.expected;
    if (pass !== item.passes.length) {
      failures.push(`case ${index}: ran ${pass} passes, the exporter ran ${item.passes.length}`);
    }
    if (got.cornerRefined.some((refined, corner) => refined !== want.corner_refined[corner])) {
      failures.push(`case ${index}: refined ${JSON.stringify(got.cornerRefined)}, want ${JSON.stringify(want.corner_refined)}`);
    }
    got.corners.forEach((point, corner) => {
      cornerError = Math.max(cornerError, Math.abs(point.x - want.corners[corner].x), Math.abs(point.y - want.corners[corner].y));
      uncertaintyError = Math.max(uncertaintyError,
        Math.abs(got.cornerUncertainty[corner] - want.corner_uncertainty[corner]) / want.corner_uncertainty[corner]);
    });
  }
  // The transforms are float32 on both sides; one rounding step apart at most.
  if (!(affineError <= 1e-6)) {
    failures.push(`crop transforms differ by ${affineError}`);
  }
  if (!(cornerError <= fixture.tolerance)) {
    failures.push(`refined corners differ by ${cornerError}`);
  }
  if (!(uncertaintyError <= 1e-9)) {
    failures.push(`corner uncertainty differs by ${uncertaintyError} (relative)`);
  }
}

const report = {
  model_version: manifest.model_version,
  refiner_affine_max_abs_error: affineError,
  refiner_corner_max_abs_error: cornerError,
  refiner_uncertainty_max_relative_error: uncertaintyError,
  passed: failures.length === 0,
  failures,
};
writeFileSync(join(root, 'app-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) {
  console.error(`extractor app verification FAILED for ${manifest.model_version}:`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}
console.log(
  `extractor app verification passed: refiner transforms ${affineError.toExponential(2)}, ` +
    `corners ${cornerError.toExponential(2)} over ${manifest.refiner.fixture}`,
);
