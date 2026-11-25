// One card per visit (AppPlan, Phase A5): the scanner adds each card it locks on once while it stays in view. A
// visit is one card: a different card starts a new one and is added at once, and a card seen earlier in the run is
// added again once it has been out of sight for the cooldown. The same card staying in view ends its visit only when
// the frame is truly empty for a while, not on a blip; coming back soon after it was last seen is the same visit.
// Another copy on purpose: lift the card out for a couple of seconds, or tap + on the tray. Checked by
// scripts/check-visit-tracker.mjs.

/** The frame must be empty this long… */
export const VISIT_END_MS = 1000;
/** …over at least this many analysed frames (a slow or paused phone sees too few to be sure) to end a visit. */
export const VISIT_END_FRAMES = 5;
/** The same card isn't added again until it has been out of sight this long. */
export const SAME_CARD_COOLDOWN_MS = 2000;

export interface VisitTracker {
  /** Why it last added, held back or re-armed, for the scanner's debug overlay. */
  note: string;
  /** One analysed frame; `empty` when the extractor saw no card at all. */
  frame(empty: boolean, now: number): void;
  /** The scanner is locked on a card: true when it should go in the tray. */
  locked(oracleId: string, now: number): boolean;
}

export function createVisitTracker(): VisitTracker {
  /** The card of the current visit, or null once the frame has been empty long enough. */
  let current: string | null = null;
  const lastSeen = new Map<string, number>();
  let emptySince: number | null = null;
  let emptyFrames = 0;
  return {
    note: 'no card yet',
    frame(empty, now) {
      if (!empty) {
        emptySince = null;
        emptyFrames = 0;
        return;
      }
      emptySince ??= now;
      emptyFrames += 1;
      if (current !== null && now - emptySince >= VISIT_END_MS && emptyFrames >= VISIT_END_FRAMES) {
        current = null;
        this.note = `re-armed: empty ${now - emptySince} ms over ${emptyFrames} frames`;
      }
    },
    locked(oracleId, now) {
      const previous = lastSeen.get(oracleId);
      lastSeen.set(oracleId, now);
      if (oracleId === current) {
        this.note = 'held: already added this visit';
        return false;
      }
      if (previous !== undefined && now - previous < SAME_CARD_COOLDOWN_MS) {
        // Back too soon (a lock wobble, or lifted out only briefly): its visit carries on.
        current = oracleId;
        this.note = `cooldown: seen ${now - previous} ms ago`;
        return false;
      }
      current = oracleId;
      this.note = 'added';
      return true;
    },
  };
}
