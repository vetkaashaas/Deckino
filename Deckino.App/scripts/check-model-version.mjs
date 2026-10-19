// Which model the app downloads and runs (src/scan/model-version.ts).
// Run: node --experimental-strip-types scripts/check-model-version.mjs
import assert from 'node:assert/strict';

import { runnableVersion, updateAction } from '../src/scan/model-version.ts';

const bundled = 'artwork-run-20261011T215447504Z';
const newer = 'artwork-run-20261101T080000000Z';
const newest = 'artwork-run-20261201T080000000Z';
const older = 'artwork-run-20260929T150035682Z';

// A newer published model downloads once; the same one again doesn't.
assert.equal(updateAction(newer, bundled, null, []), 'download');
assert.equal(updateAction(newer, bundled, newer, []), 'none');
assert.equal(updateAction(newest, bundled, newer, []), 'download');
// One that failed to load is never downloaded again.
assert.equal(updateAction(newer, bundled, null, [newer]), 'none');
// Nothing published keeps what the app has; a rollback to the bundled model or older drops the download.
assert.equal(updateAction(null, bundled, newer, []), 'none');
assert.equal(updateAction(bundled, bundled, null, []), 'none');
assert.equal(updateAction(older, bundled, newer, []), 'use-bundled');
// A rollback to an older download that is still newer than the bundled one downloads it.
assert.equal(updateAction(newer, bundled, newest, []), 'download');

// A download runs only while newer than the build's own (an app update can bundle a newer one) and not failed.
assert.equal(runnableVersion(bundled, newer, []), newer);
assert.equal(runnableVersion(bundled, null, []), null);
assert.equal(runnableVersion(newest, newer, []), null);
assert.equal(runnableVersion(bundled, newer, [newer]), null);

console.log('model version checks passed');
