import type { RecognitionMethod as ApiRecognitionMethod } from '@/api/generated';
import type { NormalizedPoint } from '@/extraction/types';
import type { ArtworkRecognition, ArtworkRecognizer } from './artwork/artwork-recognizer';
import type { RgbImage } from './artwork/recognition-crop';
import type { TitleMatcher } from './title/title-core';
import type { TitleReader } from './title/title-reader';

/** How a frame's card was found: the artwork model alone, or its printed name. Sent with training captures. */
export type RecognitionMethod = NonNullable<ApiRecognitionMethod>;

export interface Identification {
  recognition: ArtworkRecognition;
  /** The card this frame names, or null. */
  oracleId: string | null;
  name: string;
  /** The matched artwork, when the card came from the artwork model's candidates. */
  illustrationId: string | null;
  /** The artwork model's score for the card (0 when it was not among its candidates). */
  confidence: number;
  method: RecognitionMethod;
  /** What the title read (normalized), or null when it was not read. */
  titleText: string | null;
  titleMs: number | null;
}

let titleReadWarned = false;

export interface TitleFallback {
  reader: TitleReader;
  matcher: TitleMatcher;
  /** Card name by oracle id, from the artwork labels. */
  nameOf(oracleId: string): string;
}

/**
 * The artwork model first. Only when it is unsure does the card's printed name decide: one of its top 5
 * by name, else one card from all names. A frame it accepts costs nothing extra.
 */
export async function identify(
  recognizer: ArtworkRecognizer,
  title: TitleFallback | null,
  image: RgbImage,
  corners: NormalizedPoint[],
): Promise<Identification> {
  const recognition = await recognizer.recognize(image, corners);
  const { decision } = recognition;
  const artwork: Identification = {
    recognition,
    oracleId: decision.oracleId,
    name: decision.candidate.name,
    illustrationId: decision.rejected ? null : decision.candidate.illustrationId,
    confidence: decision.rejected ? 0 : decision.score,
    method: 'embeddings',
    titleText: null,
    titleMs: null,
  };
  if (!decision.rejected || title === null) return artwork;

  const started = Date.now();
  let lines: string[];
  try {
    lines = await title.reader.read(image, corners);
  } catch (error) {
    // The title reader is optional: a failed read must not lose the artwork model's answer. Warned once: it
    // would otherwise fail on most frames.
    if (!titleReadWarned) {
      titleReadWarned = true;
      console.warn(`title read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return artwork;
  }
  const match = title.matcher.match(
    lines,
    decision.candidates.map((candidate) => candidate.oracleId),
  );
  const read = { ...artwork, titleText: lines[0] ?? '', titleMs: Date.now() - started };
  if (match === null) return read;
  const candidate = decision.candidates.find((item) => item.oracleId === match.oracle_id);
  return {
    ...read,
    oracleId: match.oracle_id,
    name: title.nameOf(match.oracle_id),
    illustrationId: candidate?.illustrationId ?? null,
    confidence: candidate?.score ?? 0,
    method: match.method,
  };
}
