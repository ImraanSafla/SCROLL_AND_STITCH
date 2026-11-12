/**
 * Rendering: turns a compositing plan into the final image file(s).
 *
 * Memory: only the strips actually used are kept (as ImageBitmaps), never
 * whole frames, and the output is produced in 512-row bands.
 *
 * PNG (default): one image of any height, via the streaming encoder, so
 * we are never limited by the canvas size.
 * JPEG: browsers can only make JPEGs from a canvas, so very tall results
 * are split into parts no taller than JPEG_PART_MAX rows.
 */
import { findRecordingPill, paintOver, type Rect } from '../engine/pill';
import type { Plan, Segment } from '../engine/compose';
import { PngStreamEncoder } from '../lib/png-stream';
import type { FrameSource } from '../video/source';

export type Format = 'png' | 'jpeg';

export interface RenderOptions {
  format?: Format;
  /** JPEG quality, 0–1. */
  quality?: number;
  /** Paint over the red recording indicator (default true). */
  hidePill?: boolean;
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  blobs: Blob[];
  width: number;
  height: number;
  /** Heights of each part (one entry for PNG). */
  parts: number[];
  pill: Rect | null;
  timings: { strips: number; encode: number; total: number };
}

/**
 * JPEG parts stay under 16,384 rows: within every current browser's
 * canvas limits, including older iOS (16.7 million pixels at ~1,000 px wide).
 */
export const JPEG_PART_MAX = 16_384;
const BAND = 512;

interface Placed {
  seg: Segment;
  bmp: ImageBitmap;
}

export async function render(plan: Plan, source: FrameSource, options: RenderOptions = {}): Promise<RenderResult> {
  const format = options.format ?? 'png';
  const hidePill = options.hidePill ?? true;
  const t0 = performance.now();
  const W = plan.width;
  const H = plan.height;

  // 1. Cut every strip we need, decoding each frame once.
  const segs = [plan.header, ...plan.segments, plan.footer].filter((s) => s.rows > 0);
  const bitmaps = await source.grabStrips(segs.map((s) => ({ time: s.time, y: s.srcY, rows: s.rows })));
  const placed: Placed[] = segs.map((seg, i) => ({ seg, bmp: bitmaps[i] }));
  const tStrips = performance.now();

  // The recording indicator lives in the status bar, inside the header.
  const statusRows = Math.min(plan.header.rows, Math.round(plan.frameHeight * 0.08));
  let pill: Rect | null = null;

  const drawRows = (ctx: OffscreenCanvasRenderingContext2D, y0: number, rows: number) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, rows);
    for (const { seg, bmp } of placed) {
      const a = Math.max(y0, seg.dstY);
      const b = Math.min(y0 + rows, seg.dstY + seg.rows);
      if (a >= b) continue;
      ctx.drawImage(bmp, 0, a - seg.dstY, W, b - a, 0, a - y0, W, b - a);
    }
    // Paint over the indicator if this band includes the status bar.
    if (hidePill && y0 < statusRows) {
      const n = Math.min(rows, statusRows - y0);
      const img = ctx.getImageData(0, 0, W, n);
      const found = y0 === 0 ? findRecordingPill(img.data, W, n) : pill;
      if (found) {
        pill = found;
        paintOver(img.data, W, n, found);
        ctx.putImageData(img, 0, 0);
      }
    }
  };

  const blobs: Blob[] = [];
  const parts: number[] = [];
  try {
    if (format === 'png') {
      const enc = new PngStreamEncoder(W, H);
      const band = new OffscreenCanvas(W, BAND);
      const ctx = band.getContext('2d', { willReadFrequently: true })!;
      for (let y0 = 0; y0 < H; y0 += BAND) {
        const rows = Math.min(BAND, H - y0);
        drawRows(ctx, y0, rows);
        await enc.writeRows(ctx.getImageData(0, 0, W, rows).data, rows);
        options.onProgress?.((y0 + rows) / H);
      }
      band.width = band.height = 0;
      blobs.push(await enc.finish());
      parts.push(H);
    } else {
      for (let y0 = 0; y0 < H; y0 += JPEG_PART_MAX) {
        const rows = Math.min(JPEG_PART_MAX, H - y0);
        const canvas = new OffscreenCanvas(W, rows);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        // drawRows works in canvas-relative rows; draw the part in bands.
        for (let b = 0; b < rows; b += BAND) {
          const n = Math.min(BAND, rows - b);
          const band = new OffscreenCanvas(W, n);
          const bctx = band.getContext('2d', { willReadFrequently: true })!;
          drawRows(bctx, y0 + b, n);
          ctx.drawImage(band, 0, b);
          band.width = band.height = 0;
        }
        blobs.push(await canvas.convertToBlob({ type: 'image/jpeg', quality: options.quality ?? 0.9 }));
        parts.push(rows);
        canvas.width = canvas.height = 0;
        options.onProgress?.((y0 + rows) / H);
      }
    }
  } finally {
    for (const p of placed) p.bmp?.close();
  }
  const t1 = performance.now();
  return {
    blobs,
    width: W,
    height: H,
    parts,
    pill,
    timings: {
      strips: Math.round(tStrips - t0),
      encode: Math.round(t1 - tStrips),
      total: Math.round(t1 - t0),
    },
  };
}
