import { Images } from 'react-native-nitro-image';

import type { NormalizedPoint } from '@/extraction/types';
import type { ArtworkCandidate } from '@/recognition/artwork/artwork-decision';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';

// TEMPORARY until the app has accounts: dev builds made with both variables set
// upload scans to the API's training-capture endpoint, which stores them for the
// Toolbox to annotate. The key is baked into the build, so never set it in a
// build that leaves your hands.
const UPLOAD_URL = process.env.EXPO_PUBLIC_TRAINING_UPLOAD_URL;
const UPLOAD_KEY = process.env.EXPO_PUBLIC_TRAINING_UPLOAD_KEY;

export const trainingUploadConfigured = !!UPLOAD_URL && !!UPLOAD_KEY;

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

export interface TrainingCapture {
  image: RgbImage;
  corners: NormalizedPoint[];
  kind: 'locked' | 'unidentified';
  /** What is in view: the locked oracle, or 'unidentified'. A new subject skips the wait. */
  subject: string;
  candidates: ArtworkCandidate[];
  predictedOracleId: string | null;
  modelVersion: string;
  extractorVersion: string;
  /** Turn the photo and its corners 180° before upload so the photo is upright. */
  upsideDown: boolean;
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
  let inFlight = false;
  let sent = 0;
  let failed = 0;
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
    inFlight = true;
    lastSubject = capture.subject;
    lastSentAt = now;
    upload(capture)
      .then(
        () => {
          sent += 1;
          onStatus(`training uploads: ${sent} sent, ${failed} failed`);
        },
        (error: unknown) => {
          failed += 1;
          onStatus(
            `training uploads: ${sent} sent, ${failed} failed · ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      )
      .finally(() => {
        inFlight = false;
      });
  };
}

function maxMotion(a: NormalizedPoint[], b: NormalizedPoint[]): number {
  let max = Number.POSITIVE_INFINITY;
  if (a.length === b.length) {
    max = 0;
    for (const corner of a) {
      const other = b.find((point) => point.name === corner.name);
      if (other === undefined) return Number.POSITIVE_INFINITY;
      max = Math.max(max, Math.hypot(corner.x - other.x, corner.y - other.y));
    }
  }
  return max;
}

async function upload(capture: TrainingCapture): Promise<void> {
  const jpeg = await encodeJpeg(capture.image, capture.upsideDown);
  // Corners are named after the card's own corners, so turning the photo moves them
  // but keeps their names.
  const corners = CORNER_ORDER.map((name) => {
    const corner = capture.corners.find((point) => point.name === name);
    if (corner === undefined) throw new Error(`missing ${name} corner`);
    return capture.upsideDown
      ? { x: 1 - corner.x, y: 1 - corner.y }
      : { x: corner.x, y: corner.y };
  });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
  const response = await fetch(`${UPLOAD_URL}/api/dev/training-captures`, {
    method: 'POST',
    signal: abort.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Deckino-Upload-Key': UPLOAD_KEY!,
    },
    body: JSON.stringify({
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
    }),
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
