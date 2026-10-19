import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Images } from 'react-native-nitro-image';

import { letterboxPackedRgbToPlanarRgb } from '@/extraction/cpu-letterbox';
import type { ExtractionResult } from '@/extraction/types';
import type { ArtworkRecognition } from '@/recognition/artwork/artwork-recognizer';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import {
  EXTRACTOR_INPUT_SIZE,
  getArtworkRecognizer,
  getExtractor,
  refineFrameCorners,
  runExtractor,
} from './models';

/** The camera's recognition frame is 480x640; a shared photo is brought down to the same long side. */
const LONG_SIDE = 640;

export interface StillScan {
  /** The downscaled, upright photo the models saw (file URI, for display). */
  uri: string;
  image: RgbImage;
  extraction: ExtractionResult;
  /** Null when the extractor found no card. */
  recognition: ArtworkRecognition | null;
  modelVersion: string;
  extractorVersion: string;
}

/** Run one photo through the same extractor and artwork recognizer as the camera. */
export async function scanStill(sourceUri: string): Promise<StillScan> {
  // The manipulator reads Android content:// URIs, applies the EXIF rotation and
  // writes a small upright JPEG the pixel reader can open from disk.
  const context = ImageManipulator.manipulate(sourceUri);
  const original = await context.renderAsync();
  const scale = Math.min(1, LONG_SIDE / Math.max(original.width, original.height));
  context.resize({
    width: Math.round(original.width * scale),
    height: Math.round(original.height * scale),
  });
  const saved = await (await context.renderAsync()).saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.95,
  });

  const decoded = await Images.loadFromFileAsync(saved.uri.replace(/^file:\/\//, ''));
  const raw = await decoded.toRawPixelDataAsync();
  // Four bytes a pixel, red first or blue first; the fourth byte (alpha or padding) is ignored.
  const bgra = raw.pixelFormat === 'BGRA' || raw.pixelFormat === 'BGRX';
  if (!bgra && raw.pixelFormat !== 'RGBA' && raw.pixelFormat !== 'RGBX') {
    throw new Error(`unsupported pixel format ${raw.pixelFormat}`);
  }
  const bytes = new Uint8Array(raw.buffer);
  const { width, height } = raw;
  // Rows may be padded past width * 4.
  const stride = Math.floor(bytes.length / height);
  const image = toPlanarRgb(bytes, width, height, stride, bgra);

  const [extractor, recognizer] = await Promise.all([getExtractor(), getArtworkRecognizer()]);
  const pixels = letterboxPackedRgbToPlanarRgb(
    bytes,
    width,
    height,
    stride,
    bgra ? 'rgb-bgra-8-bit' : 'rgb-rgba-8-bit',
    'up',
    false,
    EXTRACTOR_INPUT_SIZE,
  );
  const extraction = await runExtractor(extractor, pixels, width, height, 0);
  if (extraction.accepted && extraction.corners !== null) {
    // One photo has no frame budget, so it always gets the refined corners (the camera's
    // high-accuracy setting); they are drawn, recognized and uploaded. If the refiner
    // cannot run, the extractor's corners still scan, as on the camera.
    try {
      extraction.corners = (await refineFrameCorners(image, extraction.corners)).corners;
    } catch (error) {
      console.warn(`Deckino refiner failed on a shared photo: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const recognition =
    extraction.accepted && extraction.corners !== null
      ? await recognizer.recognize(image, extraction.corners)
      : null;
  return {
    uri: saved.uri,
    image,
    extraction,
    recognition,
    modelVersion: recognizer.modelVersion,
    extractorVersion: extractor.manifest.model_version,
  };
}

/** Interleaved RGBA/BGRA to the planar RGB the recognizer (and the training upload) take. */
function toPlanarRgb(
  bytes: Uint8Array,
  width: number,
  height: number,
  stride: number,
  bgra: boolean,
): RgbImage {
  const plane = width * height;
  const data = new Uint8Array(plane * 3);
  const red = bgra ? 2 : 0;
  const blue = bgra ? 0 : 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * stride + x * 4;
      const index = y * width + x;
      data[index] = bytes[source + red];
      data[plane + index] = bytes[source + 1];
      data[2 * plane + index] = bytes[source + blue];
    }
  }
  return { data, width, height, layout: 'planar' };
}
