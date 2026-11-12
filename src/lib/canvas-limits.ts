/**
 * Canvas size limits.
 *
 * What is known (to be confirmed on a real iPhone with the Milestone 1 lab):
 * - iOS Safari limits each canvas to 16,777,216 pixels (4096 × 4096 worth of
 *   area). Larger canvases fail to allocate: getContext() may still return a
 *   context, but drawing silently does nothing. At 1179 px wide that is
 *   ~14,230 px tall; at 1320 px wide, ~12,710 px.
 * - Desktop Safari and Chrome allow much more (up to 32,767 px per side and
 *   ~268 million pixels in Chrome), but we design for the iPhone limit.
 * - iOS also has a total budget for all live canvases in a page (a few
 *   hundred MB). Canvases are only returned to that budget when they are
 *   resized to 0 × 0 or garbage collected, so we always zero them after use.
 *
 * We probe rather than trust a hard-coded number, because WebKit has
 * changed these limits before.
 */

/** Conservative default if probing is not possible. */
export const IOS_CANVAS_MAX_AREA = 16_777_216;

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
