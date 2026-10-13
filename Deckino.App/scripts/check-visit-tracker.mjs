// The scanner's "one card per visit" rule (src/scan/visit-tracker.ts), checked on its own because the emulator's
// camera can't scan a card. Run: node --experimental-strip-types scripts/check-visit-tracker.mjs
//
// Ways it could fail, each checked below:
// 1. The same card held steady, its lock flickering (glare, a wobble), is added again.
// 2. A short presence dip while the card is held (under a second, or too few frames) ends the visit.
// 3. A second of "empty" made of only a couple of frames (a slow or paused phone) ends the visit.
// 4. The lock wobbling A→B→A adds A twice.
// 5. A real swap to another card, with no empty frame between, isn't added at once.
// 6. The same card lifted out for a while and put back isn't added again.
// 7. The same card put back within the cooldown (even after the visit ended) is added again.
// 8. A non-empty frame inside an empty stretch doesn't restart the count, so scattered dips add up.
// 9. The very first card isn't added.
import assert from 'node:assert/strict';

import {
  SAME_CARD_COOLDOWN_MS,
  VISIT_END_FRAMES,
  VISIT_END_MS,
  createVisitTracker,
} from '../src/scan/visit-tracker.ts';

/** Frames 100 ms apart, as the scanner analyses them, from `start`; returns the time after the last. */
function frames(tracker, empty, count, start, step = 100) {
  for (let i = 0; i < count; i++) tracker.frame(empty, start + i * step);
  return start + count * step;
}

// 9, 1: the first card is added; held with a flickering lock, never again.
{
  const t = createVisitTracker();
  assert.equal(t.locked('A', 0), true);
  for (let now = 100; now < 3000; now += 100) {
    t.frame(false, now);
    if (now % 500 !== 0) assert.equal(t.locked('A', now), false);
  }
}

// 2: dips under a second while held don't end the visit.
{
  const t = createVisitTracker();
  t.locked('A', 0);
  let now = frames(t, true, 5, 100); // 500 ms empty
  now = frames(t, false, 1, now);
  now = frames(t, true, 5, now);
  assert.equal(t.locked('A', now + SAME_CARD_COOLDOWN_MS), false);
}

// 3: a long gap made of too few frames doesn't end the visit.
{
  const t = createVisitTracker();
  t.locked('A', 0);
  const now = frames(t, true, VISIT_END_FRAMES - 1, 100, 1000);
  assert.equal(t.locked('A', now + SAME_CARD_COOLDOWN_MS), false);
}

// 4, 5: a swap adds the new card at once; wobbling back adds nothing.
{
  const t = createVisitTracker();
  assert.equal(t.locked('A', 0), true);
  assert.equal(t.locked('B', 100), true);
  assert.equal(t.locked('A', 200), false);
  assert.equal(t.locked('B', 5000), false);
}

// 6: lifted out long enough, the same card counts again.
{
  const t = createVisitTracker();
  t.locked('A', 0);
  const now = frames(t, true, 25, 100); // 2.5 s empty
  assert.equal(t.locked('A', now), true);
  assert.match(t.note, /added/);
}

// 7: back within the cooldown it doesn't, even though the visit ended, and not while it stays.
{
  const t = createVisitTracker();
  t.locked('A', 0);
  const now = frames(t, true, Math.max(VISIT_END_FRAMES, VISIT_END_MS / 100) + 1, 100); // ~1.2 s empty
  assert.ok(now < SAME_CARD_COOLDOWN_MS);
  assert.match(t.note, /re-armed/);
  for (let held = now; held < now + 3000; held += 100) assert.equal(t.locked('A', held), false);
  assert.match(t.note, /cooldown/);
}

// 8: an empty stretch broken by a card starts over.
{
  const t = createVisitTracker();
  t.locked('A', 0);
  let now = frames(t, true, 8, 100);
  now = frames(t, false, 1, now);
  now = frames(t, true, 8, now);
  assert.equal(t.locked('B', now), true); // a new card is fine
  assert.equal(t.locked('A', now + SAME_CARD_COOLDOWN_MS + 100), false); // A's visit never ended
}

console.log('visit tracker: all checks pass');
