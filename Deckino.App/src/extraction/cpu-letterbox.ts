import type { CameraOrientation, Frame } from 'react-native-vision-camera';

import { letterboxGeometry, UNIFORM_CONTAIN_SCALE } from './letterbox';

function orientationDegrees(orientation: CameraOrientation): number {
  'worklet';
  switch (orientation) {
    case 'right':
      return 90;
    case 'down':
      return 180;
    case 'left':
      return 270;
    default:
      return 0;
  }
}

function orientedSize(
  width: number,
  height: number,
  orientation: CameraOrientation,
): { width: number; height: number } {
  'worklet';
  const sideways = orientation === 'left' || orientation === 'right';
  return sideways
    ? { width: height, height: width }
    : { width, height };
}

function letterboxYuvToPlanarRgb(
  frame: Frame,
  inputSize: number,
): Float32Array {
  'worklet';
  const planes = frame.getPlanes();
  const yPlane = planes[0];
  const yData = new Uint8Array(yPlane.getPixelBuffer());
  const yStride = yPlane.bytesPerRow > 0 ? yPlane.bytesPerRow : frame.width;
  const isFullRange = frame.pixelFormat.indexOf('full') >= 0;

  let uData: Uint8Array;
  let vData: Uint8Array;
  let uStride: number;
  let vStride: number;
  let chromaPixelStride = 1;
  if (planes.length >= 3) {
    const uPlane = planes[1];
    const vPlane = planes[2];
    uData = new Uint8Array(uPlane.getPixelBuffer());
    vData = new Uint8Array(vPlane.getPixelBuffer());
    uStride = uPlane.bytesPerRow > 0 ? uPlane.bytesPerRow : uPlane.width;
    vStride = vPlane.bytesPerRow > 0 ? vPlane.bytesPerRow : vPlane.width;
    const chromaWidth = Math.max(1, uPlane.width);
    chromaPixelStride = Math.max(1, (uStride / chromaWidth) | 0);
  } else if (planes.length === 2) {
    const uvPlane = planes[1];
    const uvData = new Uint8Array(uvPlane.getPixelBuffer());
    uData = uvData;
    vData = uvData;
    uStride = uvPlane.bytesPerRow > 0 ? uvPlane.bytesPerRow : frame.width;
    vStride = uStride;
    chromaPixelStride = 2;
  } else {
    throw new Error('Unsupported planar YUV layout.');
  }

  const width = frame.width;
  const height = frame.height;
  const upright = orientedSize(width, height, frame.orientation);
  const geometry = letterboxGeometry(
    upright.width,
    upright.height,
    inputSize,
    UNIFORM_CONTAIN_SCALE,
  );
  const inverseRotation =
    (360 - orientationDegrees(frame.orientation)) % 360;
  const plane = inputSize * inputSize;
  const pixels = new Float32Array(plane * 3);
  const twoPlaneVu = planes.length === 2;
  const left = geometry.left;
  const top = geometry.top;
  const resizedWidth = geometry.resizedWidth;
  const resizedHeight = geometry.resizedHeight;
  const mirrored = frame.isMirrored;

  for (let y = top; y < top + resizedHeight; y += 1) {
    for (let x = left; x < left + resizedWidth; x += 1) {
      let u = (x + 0.5 - left) / resizedWidth;
      let v = (y + 0.5 - top) / resizedHeight;
      if (inverseRotation === 90) {
        const nextU = 1 - v;
        v = u;
        u = nextU;
      } else if (inverseRotation === 180) {
        u = 1 - u;
        v = 1 - v;
      } else if (inverseRotation === 270) {
        const nextU = v;
        v = 1 - u;
        u = nextU;
      }
      if (mirrored) {
        u = 1 - u;
      }
      const px = Math.min(width - 1, Math.max(0, (u * width) | 0));
      const py = Math.min(height - 1, Math.max(0, (v * height) | 0));
      const yValue = yData[py * yStride + px];
      const cx = px >> 1;
      const cy = py >> 1;
      let uValue: number;
      let vValue: number;
      if (twoPlaneVu) {
        const uvIndex = cy * uStride + cx * 2;
        vValue = uData[uvIndex];
        uValue = uData[uvIndex + 1];
      } else {
        uValue = uData[cy * uStride + cx * chromaPixelStride];
        vValue = vData[cy * vStride + cx * chromaPixelStride];
      }
      const d = uValue - 128;
      const e = vValue - 128;
      let r: number;
      let g: number;
      let b: number;
      if (isFullRange) {
        r = yValue + 1.402 * e;
        g = yValue - 0.344 * d - 0.714 * e;
        b = yValue + 1.772 * d;
      } else {
        const c = 1.164 * (yValue - 16);
        r = c + 1.596 * e;
        g = c - 0.392 * d - 0.813 * e;
        b = c + 2.017 * d;
      }
      if (r < 0) {
        r = 0;
      } else if (r > 255) {
        r = 255;
      }
      if (g < 0) {
        g = 0;
      } else if (g > 255) {
        g = 255;
      }
      if (b < 0) {
        b = 0;
      } else if (b > 255) {
        b = 255;
      }
      const index = y * inputSize + x;
      pixels[index] = r / 255;
      pixels[plane + index] = g / 255;
      pixels[plane * 2 + index] = b / 255;
    }
  }
  return pixels;
}

function letterboxPackedRgbToPlanarRgb(
  bytes: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  pixelFormat: string,
  orientation: CameraOrientation,
  isMirrored: boolean,
  inputSize: number,
): Float32Array {
  'worklet';
  let red = 0;
  let green = 1;
  let blue = 2;
  let bytesPerPixel = 4;
  if (pixelFormat === 'rgb-bgra-8-bit') {
    red = 2;
    green = 1;
    blue = 0;
  } else if (pixelFormat === 'rgb-rgb-8-bit') {
    bytesPerPixel = 3;
  }
  const stride = bytesPerRow > 0 ? bytesPerRow : width * bytesPerPixel;
  const upright = orientedSize(width, height, orientation);
  const geometry = letterboxGeometry(
    upright.width,
    upright.height,
    inputSize,
    UNIFORM_CONTAIN_SCALE,
  );
  const inverseRotation = (360 - orientationDegrees(orientation)) % 360;
  const plane = inputSize * inputSize;
  const pixels = new Float32Array(plane * 3);
  const left = geometry.left;
  const top = geometry.top;
  const resizedWidth = geometry.resizedWidth;
  const resizedHeight = geometry.resizedHeight;

  for (let y = top; y < top + resizedHeight; y += 1) {
    for (let x = left; x < left + resizedWidth; x += 1) {
      let u = (x + 0.5 - left) / resizedWidth;
      let v = (y + 0.5 - top) / resizedHeight;
      if (inverseRotation === 90) {
        const nextU = 1 - v;
        v = u;
        u = nextU;
      } else if (inverseRotation === 180) {
        u = 1 - u;
        v = 1 - v;
      } else if (inverseRotation === 270) {
        const nextU = v;
        v = 1 - u;
        u = nextU;
      }
      if (isMirrored) {
        u = 1 - u;
      }
      const px = Math.min(width - 1, Math.max(0, (u * width) | 0));
      const py = Math.min(height - 1, Math.max(0, (v * height) | 0));
      const offset = py * stride + px * bytesPerPixel;
      const index = y * inputSize + x;
      pixels[index] = bytes[offset + red] / 255;
      pixels[plane + index] = bytes[offset + green] / 255;
      pixels[plane * 2 + index] = bytes[offset + blue] / 255;
    }
  }
  return pixels;
}

export function letterboxFrameToPlanarRgb(
  frame: Frame,
  inputSize: number,
): { pixels: Float32Array; width: number; height: number } {
  'worklet';
  const upright = orientedSize(frame.width, frame.height, frame.orientation);
  if (frame.isPlanar && frame.getPlanes().length >= 2) {
    return {
      pixels: letterboxYuvToPlanarRgb(frame, inputSize),
      width: upright.width,
      height: upright.height,
    };
  }
  if (!frame.hasPixelBuffer) {
    throw new Error('Frame has no CPU-accessible pixel buffer.');
  }
  return {
    pixels: letterboxPackedRgbToPlanarRgb(
      new Uint8Array(frame.getPixelBuffer()),
      frame.width,
      frame.height,
      frame.bytesPerRow,
      frame.pixelFormat,
      frame.orientation,
      frame.isMirrored,
      inputSize,
    ),
    width: upright.width,
    height: upright.height,
  };
}

export function orientedFrameSize(
  width: number,
  height: number,
  orientation: CameraOrientation,
): { width: number; height: number } {
  'worklet';
  return orientedSize(width, height, orientation);
}

/** Map a point in the upright (EXIF-style) image into the raw frame buffer. */
export function uprightToBufferUv(
  nx: number,
  ny: number,
  orientation: CameraOrientation,
  isMirrored: boolean,
): { u: number; v: number } {
  'worklet';
  let u = nx;
  let v = ny;
  const inverseRotation = (360 - orientationDegrees(orientation)) % 360;
  if (inverseRotation === 90) {
    const nextU = 1 - v;
    v = u;
    u = nextU;
  } else if (inverseRotation === 180) {
    u = 1 - u;
    v = 1 - v;
  } else if (inverseRotation === 270) {
    const nextU = v;
    v = 1 - u;
    u = nextU;
  }
  if (isMirrored) {
    u = 1 - u;
  }
  return { u, v };
}
