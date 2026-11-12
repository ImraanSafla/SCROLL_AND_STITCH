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
 *
 * Layout options, applied in this order: drop the fixed header and/or
 * footer, then trim rows off the top and bottom of what remains.
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
  /** Include the fixed header / footer (default true). */
  keepHeader?: boolean;
  keepFooter?: boolean;
  /** Rows to trim off the top / bottom, after header/footer choices. */
  cropTop?: number;
  cropBottom?: number;
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

/** Segments and height after the header/footer choices. */
export function layoutOf(plan: Plan, keepHeader = true, keepFooter = true) {
  const shift = keepHeader ? 0 : plan.header.rows;
  const segments: Segment[] = [
    ...(keepHeader ? [plan.header] : []),
    ...plan.segments.map((s) => ({ ...s, dstY: s.dstY - shift })),
    ...(keepFooter ? [{ ...plan.footer, dstY: plan.footer.dstY - shift }] : []),
  ].filter((s) => s.rows > 0);
  const height = plan.height - shift - (keepFooter ? 0 : plan.footer.rows);
  return { segments, height };
}

export async function render(plan: Plan, source: FrameSource, options: RenderOptions = {}): Promise<RenderResult> {
  const format = options.format ?? 'png';
  const hidePill = options.hidePill ?? true;
  const keepHeader = options.keepHeader ?? true;
  const t0 = performance.now();
  const W = plan.width;
  const lay = layoutOf(plan, keepHeader, options.keepFooter ?? true);
  const cropTop = Math.max(0, Math.min(lay.height - 1, Math.round(options.cropTop ?? 0)));
  const cropBottom = Math.max(0, Math.min(lay.height - cropTop - 1, Math.round(options.cropBottom ?? 0)));
  const H = lay.height - cropTop - cropBottom;

  // 1. Cut every strip we need, decoding each frame once. Strips entirely
  // inside the trimmed-off area are skipped.
  const needed = lay.segments.filter((s) => s.dstY + s.rows > cropTop && s.dstY < cropTop + H);
  const bitmaps = await source.grabStrips(needed.map((s) => ({ time: s.time, y: s.srcY, rows: s.rows })));
  const placed: Placed[] = needed.map((seg, i) => ({ seg, bmp: bitmaps[i] }));
  const tStrips = performance.now();

  // 2. The recording indicator lives in the status bar: the top ~6.5% of a
  // frame (54 pt on an 852 pt tall iPhone screen). Not limited to the
  // detected header: on recent iOS Safari's bars are see-through, so there
  // may be no fixed header at all. Only relevant if the original top of
  // the screen is still at the top of the layout.
  const statusRows = Math.min(lay.height, Math.round(plan.frameHeight * 0.065));
  const topIsScreenTop = keepHeader || plan.header.rows === 0;
  let pill: Rect | null = null;

  const drawRaw = (ctx: OffscreenCanvasRenderingContext2D, ly0: number, rows: number) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, rows);
    for (const { seg, bmp } of placed) {
      const a = Math.max(ly0, seg.dstY);
      const b = Math.min(ly0 + rows, seg.dstY + seg.rows);
      if (a >= b) continue;
      ctx.drawImage(bmp, 0, a - seg.dstY, W, b - a, 0, a - ly0, W, b - a);
    }
  };

  if (hidePill && topIsScreenTop && statusRows > 0) {
    const c = new OffscreenCanvas(W, statusRows);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    drawRaw(ctx, 0, statusRows);
    pill = findRecordingPill(ctx.getImageData(0, 0, W, statusRows).data, W, statusRows);
    c.width = c.height = 0;
  }

  /** Draw output rows [y0, y0 + rows) (output coords, after trimming). */
  const drawRows = (ctx: OffscreenCanvasRenderingContext2D, y0: number, rows: number) => {
    const ly0 = y0 + cropTop;
    drawRaw(ctx, ly0, rows);
    if (pill && ly0 < statusRows) {
      const n = Math.min(rows, statusRows - ly0);
      const img = ctx.getImageData(0, 0, W, n);
      paintOver(img.data, W, n, { ...pill, y: pill.y - ly0 });
      ctx.putImageData(img, 0, 0);
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
