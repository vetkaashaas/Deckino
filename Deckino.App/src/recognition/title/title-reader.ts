import { Tensor, type InferenceSession } from 'onnxruntime-react-native';

import { createExtractorSession } from '@/extraction/session';
import type { CropCorner, RgbImage } from '@/recognition/artwork/recognition-crop';
import { ctcDecode, normalize, titleStrip, type TitleConstants } from './title-core';

// Must match TITLE_READER_SCHEMA_VERSION in the Toolbox's title_ocr.py.
export const TITLE_READER_SCHEMA_VERSION = 1;

/** title-manifest.json, written by `deckino_training export-title-reader`. */
export interface TitleReaderManifest {
  title_reader_schema_version: number;
  model: string;
  model_sha256: string;
  characters: string;
  constants: TitleConstants;
}

export interface TitleReader {
  constants: TitleConstants;
  /** The title read at each strip width, normalized; short reads and repeats dropped. */
  read(image: RgbImage, corners: ReadonlyArray<CropCorner>): Promise<string[]>;
}

export async function loadTitleReader(
  manifest: TitleReaderManifest,
  characters: string[],
  uri: string,
): Promise<TitleReader> {
  if (manifest.title_reader_schema_version !== TITLE_READER_SCHEMA_VERSION) {
    throw new Error(
      `title reader schema v${manifest.title_reader_schema_version}, app needs v${TITLE_READER_SCHEMA_VERSION}`,
    );
  }
  // Two threads: it runs on the recognition queue while the extractor keeps finding corners.
  const { session } = await createExtractorSession(uri, 2);
  const input = session.inputNames[0];
  const constants = manifest.constants;
  return {
    constants,
    async read(image, corners) {
      const lines: string[] = [];
      for (const right of constants.rights) {
        const strip = titleStrip(image, corners, right, constants);
        const results = await session.run({
          [input]: new Tensor('float32', strip.data, [1, 3, strip.height, strip.width]),
        });
        lines.push(normalize(ctcDecode(argmaxSteps(results[session.outputNames[0]]), characters)));
      }
      return [...new Set(lines)].filter((line) => line.length >= constants.min_line_length);
    },
  };
}

/** The best class per time step of the (1, steps, classes) output. */
function argmaxSteps(output: InferenceSession.OnnxValueMapType[string]): number[] {
  const tensor = output as Tensor;
  const [, steps, classes] = tensor.dims;
  const scores = tensor.data as Float32Array;
  const best: number[] = [];
  for (let step = 0; step < steps; step += 1) {
    let top = 0;
    const offset = step * classes;
    for (let index = 1; index < classes; index += 1) {
      if (scores[offset + index] > scores[offset + top]) top = index;
    }
    best.push(top);
  }
  return best;
}
