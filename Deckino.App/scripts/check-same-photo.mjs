// The training uploader's "same photo" rule (src/training/same-photo.ts), checked without a camera.
// Run: node --experimental-strip-types scripts/check-same-photo.mjs
import assert from 'node:assert/strict';

import { photoPrint, samePhoto } from '../src/training/same-photo.ts';

const W = 480;
const H = 640;
const box = (x0, y0, x1, y1) => [
  { name: 'TopLeft', x: x0, y: y0 },
  { name: 'TopRight', x: x1, y: y0 },
  { name: 'BottomRight', x: x1, y: y1 },
  { name: 'BottomLeft', x: x0, y: y1 },
];

/** A grey rig with a card whose art is `art(x, y)` inside `corners`, plus sensor noise. */
function frame(corners, art, noise = 3) {
  const data = new Uint8Array(W * H * 3);
  const [x0, x1, y0, y1] = [corners[0].x * W, corners[1].x * W, corners[0].y * H, corners[2].y * H];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      const value = (inside ? art((x - x0) / (x1 - x0), (y - y0) / (y1 - y0)) : 200) + (Math.random() - 0.5) * 2 * noise;
      for (let c = 0; c < 3; c++) data[c * W * H + y * W + x] = Math.max(0, Math.min(255, value));
    }
  return { data, width: W, height: H, layout: 'planar' };
}

const place = box(0.25, 0.39, 0.6, 0.76);
const cardA = (u, v) => (u < 0.5 ? 40 : 180) + 60 * v;
const cardB = (u, v) => (v < 0.4 ? 220 : 30) + 20 * u;
const print = (corners, art, noise) => photoPrint(frame(corners, art, noise), corners);

// A card left in view: every frame is the same photo, noise or not.
assert.ok(samePhoto(print(place, cardA), print(place, cardA, 6)));
// The corners wobbling a pixel or two is still the same photo.
assert.ok(samePhoto(print(place, cardA), print(box(0.252, 0.391, 0.601, 0.761), cardA)));
// Another card in the same spot of a rig is a new photo.
assert.ok(!samePhoto(print(place, cardA), print(place, cardB)));
// The same card moved is a new photo.
assert.ok(!samePhoto(print(place, cardA), print(box(0.3, 0.39, 0.65, 0.76), cardA)));
// Too small a box to compare: no print, so the uploader always sends it.
assert.equal(photoPrint(frame(place, cardA), box(0.5, 0.5, 0.51, 0.51)), null);
console.log('same-photo: ok');
