/**
 * Tiny grayscale thumbnails for the cheap "skim" pass, plus a difference
 * score between two thumbnails. 64 px wide keeps each frame at a few KB.
 */

export const THUMB_WIDTH = 64;

export interface Thumb {
  time: number;
  width: number;
  height: number;
  gray: Uint8Array;
}

export class Thumbnailer {
  readonly width: number;
  readonly height: number;
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

  constructor(srcWidth: number, srcHeight: number, width = THUMB_WIDTH) {
    this.width = width;
    this.height = Math.max(1, Math.round((srcHeight / srcWidth) * width));
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(this.width, this.height);
    } else {
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      this.canvas = c;
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    this.ctx.imageSmoothingQuality = 'medium';
  }

  grab(src: CanvasImageSource, time: number): Thumb {
    this.ctx.drawImage(src, 0, 0, this.width, this.height);
    const d = this.ctx.getImageData(0, 0, this.width, this.height).data;
    const gray = new Uint8Array(this.width * this.height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    return { time, width: this.width, height: this.height, gray };
  }

  dispose() {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

/** Mean absolute difference between two thumbnails, 0–255. */
export function thumbDiff(a: Thumb, b: Thumb): number {
  const n = Math.min(a.gray.length, b.gray.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a.gray[i] - b.gray[i]);
  return n ? s / n : 0;
}
