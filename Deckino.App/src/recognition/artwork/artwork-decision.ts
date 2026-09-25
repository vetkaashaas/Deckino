/**
 * Turn the recognizer's top-K prototypes into a card decision.
 *
 * Mirrors `decide_top_k` in the Toolbox's `artwork_mobile.py`: collapse
 * prototype scores to the best score per oracle (a shared artwork counts for
 * each of its cards), reject ambiguous artworks, then apply the app's score and
 * margin floors. `scripts/verify-artwork-model.mjs` replays the export's
 * fixture through this file, so keep it free of runtime imports.
 */

export interface ArtworkAppLabels {
  app_labels_schema_version: number;
  model_version: string;
  oracle_ids: string[];
  names: string[];
  /** One oracle index per prototype, or a list when an artwork is shared. */
  prototype_oracles: Array<number | number[]>;
  ambiguous_prototypes: number[];
}

export interface ArtworkThresholds {
  score_threshold: number;
  margin_threshold: number;
}

export interface ArtworkCandidate {
  oracleId: string;
  name: string;
  score: number;
  prototype: number;
}

export type ArtworkRejection = 'ambiguous_artwork' | 'below_confidence_threshold';

export interface ArtworkDecision {
  rejected: boolean;
  rejectionReason: ArtworkRejection | null;
  /** The accepted oracle, or null when rejected. */
  oracleId: string | null;
  candidate: ArtworkCandidate;
  score: number;
  /** Best minus second-best oracle score; null when the catalogue has one oracle. */
  margin: number | null;
  /** True when every returned prototype was the best oracle's, so the margin is a lower bound. */
  marginIsLowerBound: boolean;
  candidates: ArtworkCandidate[];
}

const CANDIDATES = 5;

export type ArtworkDecider = (
  topScores: ArrayLike<number>,
  topPrototypes: ArrayLike<number | bigint>,
  thresholds: ArtworkThresholds,
) => ArtworkDecision;

export function createArtworkDecider(
  labels: ArtworkAppLabels,
  catalogueSize: number,
): ArtworkDecider {
  const ambiguous = new Set(labels.ambiguous_prototypes);
  const candidateFor = (
    oracle: number,
    score: number,
    prototype: number,
  ): ArtworkCandidate => ({
    oracleId: labels.oracle_ids[oracle],
    name: labels.names[oracle],
    score,
    prototype,
  });

  return (topScores, topPrototypes, thresholds) => {
    const best = new Map<number, { score: number; prototype: number }>();
    for (let index = 0; index < topScores.length; index += 1) {
      const score = topScores[index];
      const prototype = Number(topPrototypes[index]);
      const entry = labels.prototype_oracles[prototype];
      const oracles = typeof entry === 'number' ? [entry] : entry;
      for (const oracle of oracles) {
        const previous = best.get(oracle);
        if (previous === undefined || score > previous.score) {
          best.set(oracle, { score, prototype });
        }
      }
    }
    const ranked = [...best.entries()]
      .sort((left, right) => right[1].score - left[1].score || left[0] - right[0])
      .slice(0, CANDIDATES);
    const [oracle, { score, prototype }] = ranked[0];
    const marginIsLowerBound =
      ranked.length === 1 && topScores.length < catalogueSize;
    let margin: number | null;
    if (ranked.length > 1) {
      margin = score - ranked[1][1].score;
    } else {
      margin = marginIsLowerBound
        ? score - topScores[topScores.length - 1]
        : null;
    }
    const isAmbiguous = ambiguous.has(prototype);
    const rejected =
      isAmbiguous ||
      score < thresholds.score_threshold ||
      (margin !== null && margin < thresholds.margin_threshold);
    const candidate = candidateFor(oracle, score, prototype);
    return {
      rejected,
      rejectionReason: isAmbiguous
        ? 'ambiguous_artwork'
        : rejected
          ? 'below_confidence_threshold'
          : null,
      oracleId: rejected ? null : candidate.oracleId,
      candidate,
      score,
      margin,
      marginIsLowerBound,
      candidates: ranked.map(([index, value]) =>
        candidateFor(index, value.score, value.prototype),
      ),
    };
  };
}
