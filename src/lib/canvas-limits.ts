/**
 * Canvas size limits.
 *
 * Measured with the Milestone 1 lab on an iPhone running Safari 27.2
 * (12 Nov 2026):
 * - Maximum area per canvas: 67,108,864 pixels (2^26, i.e. 8192 × 8192).
 *   At 1178 px wide the tallest working canvas was 56,964 px. Older iOS
 *   versions capped this at 16,777,216 (4096 × 4096), so we keep probing
 *   rather than trusting a constant.
 * - Larger canvases fail silently: getContext() can still return a context
 *   but drawing does nothing, so we test by reading a pixel back.
 * - iOS also has a total budget for all live canvases in a page. Canvases
 *   are only returned to that budget when resized to 0 × 0 or garbage
 *   collected, so we always zero them after use.
 *
 * The stitched output never needs one giant canvas: the streaming PNG
 * encoder (png-stream.ts) writes images of any height. A 1179 × 40,000 PNG
 * encoded in 0.5 s on that iPhone and saved to Photos correctly.
 */

/** Per-canvas area limit measured on iOS Safari 27. */
export const IOS_CANVAS_MAX_AREA = 67_108_864;
/** Limit on older iOS versions; use this if probing is not possible. */
export const IOS_LEGACY_CANVAS_MAX_AREA = 16_777_216;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number, offscreen: boolean): AnyCanvas {
  if (offscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** True if a w × h canvas can actually be drawn to and read back. */
export function canvasWorks(w: number, h: number, offscreen = false): boolean {
  let c: AnyCanvas | null = null;
  try {
    c = makeCanvas(w, h, offscreen);
    const ctx = c.getContext('2d', { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return false;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    const d = ctx.getImageData(w - 1, h - 1, 1, 1).data;
    return d[0] === 255 && d[1] === 0 && d[3] === 255;
  } catch {
    return false;
  } finally {
    if (c) {
      c.width = 0;
      c.height = 0;
    }
  }
}

/** Binary search for the tallest working canvas at a given width. */
export function maxCanvasHeight(width: number, offscreen = false, lo = 1024, hi = 1 << 18): number {
  if (!canvasWorks(width, lo, offscreen)) return 0;
  while (hi - lo > 16) {
    const mid = (lo + hi) >>> 1;
    if (canvasWorks(width, mid, offscreen)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Binary search for the largest working square canvas. */
export function maxCanvasSquare(offscreen = false): number {
  let lo = 256;
  let hi = 1 << 16;
  while (hi - lo > 8) {
    const mid = (lo + hi) >>> 1;
    if (canvasWorks(mid, mid, offscreen)) lo = mid;
    else hi = mid;
  }
  return lo;
}
