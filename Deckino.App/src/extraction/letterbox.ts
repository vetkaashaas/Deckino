import type { LetterboxGeometry, NormalizedPoint } from './types';

const CORNER_NAMES = [
  'TopLeft',
  'TopRight',
  'BottomRight',
  'BottomLeft',
] as const;

export const ALIGNED_PIXEL_CENTERS = 'aligned-pixel-centers-v2';
export const UNIFORM_CONTAIN_SCALE = 'uniform-contain-scale-v1';

export function roundHalfToEven(value: number): number {
  'worklet';
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) {
    return floor + 1;
  }
  if (diff < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

export function letterboxGeometry(
  width: number,
  height: number,
  inputSize: number,
  coordinateTransform: string,
): LetterboxGeometry {
  'worklet';
  const resizeScale = Math.min(inputSize / width, inputSize / height);
  const resizedWidth = Math.max(
    1,
    Math.min(inputSize, roundHalfToEven(width * resizeScale)),
  );
  const resizedHeight = Math.max(
    1,
    Math.min(inputSize, roundHalfToEven(height * resizeScale)),
  );
  const left = Math.floor((inputSize - resizedWidth) / 2);
  const top = Math.floor((inputSize - resizedHeight) / 2);
  let scaleX = resizeScale;
  let scaleY = resizeScale;
  if (coordinateTransform === ALIGNED_PIXEL_CENTERS) {
    scaleX = width > 1 ? (resizedWidth - 1) / (width - 1) : 0;
    scaleY = height > 1 ? (resizedHeight - 1) / (height - 1) : 0;
  }
  return {
    inputSize,
    resizedWidth,
    resizedHeight,
    left,
    top,
    scaleX,
    scaleY,
  };
}

export function unletterbox(
  values: number[],
  width: number,
  height: number,
  inputSize: number,
  coordinateTransform: string,
): NormalizedPoint[] {
  'worklet';
  const geometry = letterboxGeometry(
    width,
    height,
    inputSize,
    coordinateTransform,
  );
  const corners: NormalizedPoint[] = [];
  for (let index = 0; index < 4; index += 1) {
    const pixelX =
      width > 1 && geometry.scaleX
        ? (values[index * 2] * (inputSize - 1) - geometry.left) / geometry.scaleX
        : 0;
    const pixelY =
      height > 1 && geometry.scaleY
        ? (values[index * 2 + 1] * (inputSize - 1) - geometry.top) /
          geometry.scaleY
        : 0;
    corners.push({
      x: pixelX / Math.max(1, width - 1),
      y: pixelY / Math.max(1, height - 1),
      name: CORNER_NAMES[index],
    });
  }
  return corners;
}

export function coverMap(
  nx: number,
  ny: number,
  frameWidth: number,
  frameHeight: number,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  'worklet';
  const scale = Math.max(viewWidth / frameWidth, viewHeight / frameHeight);
  const drawnWidth = frameWidth * scale;
  const drawnHeight = frameHeight * scale;
  const left = (viewWidth - drawnWidth) / 2;
  const top = (viewHeight - drawnHeight) / 2;
  return {
    x: left + nx * Math.max(1, frameWidth - 1) * scale,
    y: top + ny * Math.max(1, frameHeight - 1) * scale,
  };
}
