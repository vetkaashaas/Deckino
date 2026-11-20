import { Images } from 'react-native-nitro-image';

import { send } from '@/api/client';
import { useSignedIn } from '@/api/session';
import type { NormalizedPoint } from '@/extraction/types';
import type { ArtworkCandidate } from '@/recognition/artwork/artwork-decision';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import type { RecognitionMethod } from '@/recognition/identify';
import { debugTools, usePreferences } from '@/preferences';

import { maxMotion, photoPrint, type PhotoPrint, samePhoto } from './same-photo';

// Signed-in users who said yes to /help-improve (or turned "Help improve recognition"
// on in Profile) upload scans to the API's training-capture endpoint, which stores them,
// with the account, for the Toolbox to annotate. In developer builds the scanner sheet can block them all.

export function useTrainingUploads(): boolean {
  const { trainingPhotos, trainingPhotosAsked, blockTrainingUploads } = usePreferences();
  return useSignedIn() && trainingPhotosAsked && trainingPhotos && !(debugTools && blockTrainingUploads);
}

/** Another photo of the same card (or of the same failure) at most this often. */
const SAME_SUBJECT_INTERVAL_MS = 2000;
/** A different card uploads at once, but never faster than this (lock/unidentified flicker). */
const MIN_INTERVAL_MS = 500;
/** A corner moving more than this (fraction of the frame) between recognized frames means the card is moving. */
const STILL_MOTION = 0.015;
/** Consecutive still frames of the same subject before a frame is worth sending (blur, mid-swap frames). */
const STILL_FRAMES: Record<TrainingCapture['kind'], number> = { locked: 2, unidentified: 4 };
const JPEG_QUALITY = 90;
/** React Native's Android HTTP client never times out on its own; a stalled upload would block the next ones. */
const UPLOAD_TIMEOUT_MS = 20000;
const CORNER_ORDER = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
/** Photos sent this session that a new one is compared with (a card put back in the rig a few cards later). */
const RECENT_PHOTOS = 10;
/**
 * Per artwork model: a lock at least this sure is an easy photo the model already knows, so only an audit sample of
 * them uploads. Independent of the app's acceptance floor. Calibrated with the shipped recognizer on the reviewed,
 * held-out benchmark phone photos (labelled corners, 2026-11-20): 0.65 / 0.25 calls 342 of 440 accepted photos clear,
 * none of them wrong (0 wrong of 2,021 accepted reviewed import photos either, though the model trained on those).
 * A model missing here has not been checked, so every lock uploads as before.
 */
const CLEAR_MATCH: Record<string, { score: number; margin: number }> = {
  'artwork-run-20261119T114402214Z': { score: 0.65, margin: 0.25 },
};
/** Share of clear photos still sent, so a confidently wrong match or bad corners still reach review. Not calibrated. */
const CLEAR_AUDIT_RATE = 0.05;
/** Refined corners this far (fraction of the frame) from the extractor's: the extractor missed, worth sending. */
const CORNER_DISAGREEMENT = 0.02;

export interface TrainingCapture {
  image: RgbImage;
  corners: NormalizedPoint[];
  kind: 'locked' | 'unidentified';
  /** What is in view: the locked oracle, or 'unidentified'. A new subject skips the wait. */
  subject: string;
  candidates: ArtworkCandidate[];
  predictedOracleId: string | null;
  /** How the frame found its card (embeddings when it found none: the artwork model decided alone). */
  recognitionMethod: RecognitionMethod;
  /** What the card's title read, when the artwork model was unsure and it was read. */
  titleText: string | null;
  modelVersion: string;
  extractorVersion: string;
  /** Turn the photo and its corners 180° before upload so the photo is upright. */
  upsideDown: boolean;
  /** Where the photo came from when it is not a camera frame (the API defaults to 'phone'). */
  source?: 'shared';
}

/**
 * Returns an offer function. Call it with every recognized frame (null when the
 * frame is not uploadable) so it can tell a still card from a moving one; it
 * decides what to send.
 */
export function createTrainingUploader(onStatus: (status: string) => void) {
  let previousCorners: NormalizedPoint[] | null = null;
  let streakSubject: string | null = null;
  let streak = 0;
  let lastSubject: string | null = null;
  let lastSentAt = 0;
  let recent: PhotoPrint[] = [];
  let inFlight = false;
  let sent = 0;
  let failed = 0;
  // Clear photos left out, so later frames of one don't draw again until one passes. Kept apart from the
  // sent photos and the send timer: a skipped photo never holds back an unsure frame.
  let skipped: PhotoPrint[] = [];
  let skippedSubject: string | null = null;
  let skippedAt = 0;
  let skips = 0;
  const report = (error?: string) =>
    onStatus(`training uploads: ${sent} sent, ${failed} failed, ${skips} clear skipped${error ? ` · ${error}` : ''}`);
  return (corners: NormalizedPoint[], capture: TrainingCapture | null) => {
    const still = previousCorners !== null && maxMotion(previousCorners, corners) < STILL_MOTION;
    previousCorners = corners;
    const subject = capture?.subject ?? null;
    streak = still && subject !== null && subject === streakSubject ? streak + 1 : 0;
    streakSubject = subject;
    if (capture === null || streak < STILL_FRAMES[capture.kind]) return;
    const now = Date.now();
    if (inFlight || now - lastSentAt < MIN_INTERVAL_MS) return;
    if (capture.subject === lastSubject && now - lastSentAt < SAME_SUBJECT_INTERVAL_MS) return;
    const print = photoPrint(capture.image, capture.corners);
    const alreadySent = print !== null && recent.some((earlier) => samePhoto(earlier, print));
    if (!alreadySent && isClearMatch(capture, corners)) {
      // One draw per photo, and per subject no more often than one would have been sent. A card too small to
      // print can't be told apart from its next frames, so it never draws.
      const drawn =
        print === null ||
        skipped.some((earlier) => samePhoto(earlier, print)) ||
        (capture.subject === skippedSubject && now - skippedAt < SAME_SUBJECT_INTERVAL_MS);
      if (drawn || Math.random() >= CLEAR_AUDIT_RATE) {
        if (!drawn) {
          skipped = [print, ...skipped].slice(0, RECENT_PHOTOS);
          skippedSubject = capture.subject;
          skippedAt = now;
          skips += 1;
          report();
        }
        return;
      }
    }
    lastSubject = capture.subject;
    lastSentAt = now;
    // Whatever the subject: a lock flickering to "unidentified" on a card left in view is still the same photo.
    if (alreadySent) return;
    if (print !== null) recent = [print, ...recent].slice(0, RECENT_PHOTOS);
    inFlight = true;
    upload(capture)
      .then(
        () => {
          sent += 1;
          report();
        },
        (error: unknown) => {
          failed += 1;
          report(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        inFlight = false;
      });
  };
}

/**
 * A lock the artwork model alone was sure of, by its calibrated floor, on corners the refiner agreed with.
 * Title-reader matches, unsure frames and models without a floor are never clear. `extractorCorners` are the
 * extractor's own corners (capture.corners may be the refiner's).
 */
function isClearMatch(capture: TrainingCapture, extractorCorners: NormalizedPoint[]): boolean {
  const floor = CLEAR_MATCH[capture.modelVersion];
  const [best, second] = capture.candidates;
  return (
    floor !== undefined &&
    capture.source === undefined &&
    capture.kind === 'locked' &&
    capture.recognitionMethod === 'embeddings' &&
    best !== undefined &&
    second !== undefined &&
    best.oracleId === capture.predictedOracleId &&
    best.score >= floor.score &&
    best.score - second.score >= floor.margin &&
    maxMotion(extractorCorners, capture.corners) < CORNER_DISAGREEMENT
  );
}

export async function upload(capture: TrainingCapture): Promise<void> {
  const jpeg = await encodeJpeg(capture.image, capture.upsideDown);
  // Corners are named after the card's own corners, so turning the photo moves them
  // but keeps their names.
  const corners = CORNER_ORDER.map((name) => {
    const corner = capture.corners.find((point) => point.name === name);
    if (corner === undefined) throw new Error(`missing ${name} corner`);
    // The extractor can put a corner just outside the frame when the card runs off its edge; the
    // API only takes points inside it. These are guesses the annotator corrects, so clamping is fine.
    const x = clamp01(corner.x);
    const y = clamp01(corner.y);
    return capture.upsideDown ? { x: 1 - x, y: 1 - y } : { x, y };
  });
  await send('POST', '/api/training-captures', {
    timeoutMs: UPLOAD_TIMEOUT_MS,
    body: {
      imageJpegBase64: toBase64(jpeg),
      kind: capture.kind,
      modelVersion: capture.modelVersion,
      extractorVersion: capture.extractorVersion,
      corners,
      candidates: capture.candidates.map((candidate) => ({
        oracleId: candidate.oracleId,
        score: candidate.score,
        prototype: candidate.prototype,
      })),
      predictedOracleId: capture.predictedOracleId,
      recognitionMethod: capture.recognitionMethod,
      titleText: capture.titleText,
      source: capture.source,
    },
  });
}

/** An admin's no-card photo (the no-card camera): the API saves it already labelled "no card". */
export async function uploadNoCard(image: RgbImage): Promise<void> {
  const jpeg = await encodeJpeg(image, false);
  await send('POST', '/api/training-captures/no-card', {
    timeoutMs: UPLOAD_TIMEOUT_MS,
    body: { imageJpegBase64: toBase64(jpeg) },
  });
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Planar RGB (the recognition frame) to an interleaved RGBA image, then JPEG. */
async function encodeJpeg(image: RgbImage, upsideDown: boolean): Promise<Uint8Array> {
  const pixels = image.width * image.height;
  // One 32-bit write per pixel; on the little-endian phone this lays the bytes out as R, G, B, A.
  const rgba = new Uint32Array(pixels);
  const { data } = image;
  const green = pixels;
  const blue = 2 * pixels;
  for (let index = 0; index < pixels; index += 1) {
    rgba[upsideDown ? pixels - 1 - index : index] =
      (0xff000000 | (data[blue + index] << 16) | (data[green + index] << 8) | data[index]) >>> 0;
  }
  const decoded = await Images.loadFromRawPixelDataAsync({
    buffer: rgba.buffer,
    width: image.width,
    height: image.height,
    pixelFormat: 'RGBA',
  });
  const encoded = await decoded.toEncodedImageDataAsync('jpg', JPEG_QUALITY);
  return new Uint8Array(encoded.buffer);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
