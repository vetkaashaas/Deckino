import { colors } from '@/theme';

export type ScanTone = 'idle' | 'detecting' | 'locked' | 'rejected';

export const CARD_ASPECT_RATIO = 63 / 88;

const TONE_COLORS: Record<ScanTone, string> = {
  idle: 'rgba(255, 255, 255, 0.85)',
  detecting: colors.violet,
  locked: colors.violet, // the pop says it, with the name, chime and buzz (extraction-overlay.tsx)
  rejected: colors.danger,
};

/** The colour of a scan state: white idle, violet on a card, red when something's off. */
export const toneColor = (tone: ScanTone) => TONE_COLORS[tone];

/** Where a card is expected: the free band between the scanner's top and bottom controls. The logo waits in its
 * middle and an added card flies from there. */
export type GuideArea = { y: number; width: number; height: number };

const GUIDE_MARGIN = 16;

/** The guide's width in `area`: 72% of it, smaller when that would not fit its height. */
export function guideWidth(area: GuideArea): number {
  return Math.min(area.width * 0.72, Math.max(0, area.height - 2 * GUIDE_MARGIN) * CARD_ASPECT_RATIO);
}
