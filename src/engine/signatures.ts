/**
 * Row signatures: each row of the image is summarised as the mean brightness
 * of a few vertical bands. Comparing signatures instead of pixels is ~50×
 * cheaper and naturally tolerant of compression noise.
 *
 * The outer 3% on each side is ignored, because iOS draws its scroll
 * indicator at the right edge while scrolling.
 */
import type { GrayImage } from './gray';

export interface RowSignatures {
  rows: number;
  bands: number;
  /** rows × bands, row-major. */
  data: Float32Array;
}

export const EDGE_MARGIN = 0.03;

export function rowSignatures(img: GrayImage, bands: number): RowSignatures {
  const { width, height, data } = img;
  const x0 = Math.floor(width * EDGE_MARGIN);
  const x1 = Math.ceil(width * (1 - EDGE_MARGIN));
  const span = x1 - x0;
  const edges = new Int32Array(bands + 1);
  for (let b = 0; b <= bands; b++) edges[b] = x0 + Math.round((span * b) / bands);
  const out = new Float32Array(height * bands);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let b = 0; b < bands; b++) {
      let s = 0;
      const e = edges[b + 1];
      for (let x = edges[b]; x < e; x++) s += data[row + x];
      out[y * bands + b] = s / (e - edges[b]);
    }
  }
  return { rows: height, bands, data: out };
}

/** Mean absolute difference between row ya of `a` and row yb of `b`. */
export function rowDistance(a: RowSignatures, ya: number, b: RowSignatures, yb: number): number {
  const k = a.bands;
  const pa = ya * k;
  const pb = yb * k;
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.abs(a.data[pa + i] - b.data[pb + i]);
  return s / k;
}

/**
 * How much the content varies from row to row within [top, bottom).
 * Near zero for blank areas, where any offset matches equally well.
 */
export function texture(sig: RowSignatures, top: number, bottom: number): number {
  if (bottom - top < 2) return 0;
  let s = 0;
  for (let y = top + 1; y < bottom; y++) s += rowDistance(sig, y, sig, y - 1);
  return s / (bottom - top - 1);
}
