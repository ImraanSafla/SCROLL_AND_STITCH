/**
 * Grayscale images: the currency of the analysis engine. The engine never
 * touches video or canvas APIs, so it runs the same in a worker, on the
 * main thread, in Node tests, and later on still screenshots (Phase 2).
 */

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface GrayFrame extends GrayImage {
  /** Presentation time in seconds (or index for still images). */
  time: number;
}

/** RGBA → luma (BT.601 weights, integer approximation). */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const n = width * height;
  const data = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { width, height, data };
}

/** Box-filter downscale by an integer factor. */
export function downscale(img: GrayImage, factor: number): GrayImage {
  if (factor <= 1) return img;
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const out = new Uint8Array(w * h);
  const area = factor * factor;
  const src = img.data;
  const sw = img.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      const y0 = y * factor;
      const x0 = x * factor;
      for (let dy = 0; dy < factor; dy++) {
        let p = (y0 + dy) * sw + x0;
        for (let dx = 0; dx < factor; dx++) s += src[p++];
      }
      out[y * w + x] = (s / area + 0.5) | 0;
    }
  }
  return { width: w, height: h, data: out };
}
