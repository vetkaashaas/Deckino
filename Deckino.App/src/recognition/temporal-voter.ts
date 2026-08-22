import type { CardGuess, LockState } from './types';

export interface TemporalVoterConfig {
  windowSize: number;
  lockThreshold: number;
  releaseThreshold: number;
  marginThreshold: number;
  voteMaxAgeMs: number;
}

interface Vote {
  oracleId: string;
  confidence: number;
  at: number;
}

export type TemporalVoter = (
  guess: CardGuess | null,
  nowMs: number,
) => LockState;

export function createTemporalVoter(
  config?: TemporalVoterConfig,
): TemporalVoter {
  'worklet';
  const cfg: TemporalVoterConfig = config ?? {
    windowSize: 8,
    lockThreshold: 5,
    releaseThreshold: 2,
    marginThreshold: 0.05,
    voteMaxAgeMs: 1200,
  };
  const votes: Vote[] = [];
  let lockedId: string | null = null;
  let lockedGuess: CardGuess | null = null;

  return (guess, nowMs) => {
    while (votes.length > 0 && nowMs - votes[0].at > cfg.voteMaxAgeMs) {
      votes.shift();
    }
    if (guess !== null) {
      votes.push({
        oracleId: guess.oracleId,
        confidence: guess.confidence,
        at: nowMs,
      });
    }
    if (votes.length > cfg.windowSize) {
      votes.splice(0, votes.length - cfg.windowSize);
    }

    const tally = new Map<string, { count: number; confidenceSum: number }>();
    for (const vote of votes) {
      const entry = tally.get(vote.oracleId) ?? {
        count: 0,
        confidenceSum: 0,
      };
      entry.count += 1;
      entry.confidenceSum += vote.confidence;
      tally.set(vote.oracleId, entry);
    }

    const entries = [...tally.entries()]
      .map(([oracleId, { count, confidenceSum }]) => ({
        oracleId,
        count,
        mean: confidenceSum / count,
      }))
      .sort((a, b) => b.count - a.count || b.mean - a.mean);

    const leader = entries[0] ?? null;
    const runnerUpMean =
      entries.length > 1 ? Math.max(...entries.slice(1).map((e) => e.mean)) : 0;

    if (lockedId !== null) {
      const support =
        leader !== null && leader.oracleId === lockedId ? leader.count : 0;
      if (support < cfg.releaseThreshold) {
        lockedId = null;
        lockedGuess = null;
      }
    }

    if (
      lockedId === null &&
      leader !== null &&
      leader.count >= cfg.lockThreshold &&
      leader.mean - runnerUpMean >= cfg.marginThreshold
    ) {
      lockedId = leader.oracleId;
    }

    if (lockedId !== null && guess !== null && guess.oracleId === lockedId) {
      lockedGuess = guess;
    }

    if (lockedId !== null && lockedGuess !== null) {
      return { status: 'locked', guess: lockedGuess };
    }
    return { status: 'searching' };
  };
}
