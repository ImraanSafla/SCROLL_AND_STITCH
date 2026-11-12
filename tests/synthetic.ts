/** Synthetic grayscale pages and frames for unit tests. */
import type { GrayFrame } from '../src/engine/gray';

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export interface Page {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A page of "text" lines, image blocks and an optional blank stretch. */
export function makePage(width: number, height: number, seed = 1, blank?: [number, number]): Page {
  const r = rng(seed);
  const data = new Uint8Array(width * height).fill(250);
  const rect = (x: number, y: number, w: number, h: number, v: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      data.fill(v, yy * width + Math.max(0, x), yy * width + Math.min(width, x + w));
    }
  };
  let y = 10;
  const m = Math.round(width * 0.06);
  while (y < height - 20) {
    if (blank && y >= blank[0] && y < blank[1]) {
      y = blank[1];
      continue;
    }
    const k = r();
    if (k < 0.3) {
      const h = Math.round(height * 0.03 + r() * height * 0.05);
      rect(m, y, width - 2 * m, h, 40 + Math.floor(r() * 160));
      for (let i = 0; i < 4; i++) {
        const s = Math.round(4 + r() * h * 0.4);
        rect(m + Math.floor(r() * (width - 2 * m - s)), y + Math.floor(r() * (h - s)), s, s, Math.floor(r() * 255));
      }
      y += h + 8;
    } else {
      const lines = 2 + Math.floor(r() * 5);
      for (let i = 0; i < lines; i++) {
        let x = m;
        const end = width - m - (i === lines - 1 ? Math.floor(r() * width * 0.4) : 0);
        while (x < end - 6) {
          const w = Math.min(end - x, 6 + Math.floor(r() * width * 0.12));
          rect(x, y, w, 5, 50);
          x += w + 4;
        }
        y += 10;
      }
      y += 8;
    }
  }
  return { width, height, data };
}

export interface FrameSpec {
  frameHeight: number;
  header: number;
  footer: number;
  noise?: number;
  seed?: number;
}

/** A frame showing the page at `offset`, with fixed header and footer bands. */
export function makeFrame(page: Page, offset: number, spec: FrameSpec, time = 0): GrayFrame {
  const { width } = page;
  const { frameHeight: H, header, footer, noise = 0 } = spec;
  const r = rng((spec.seed ?? 99) + offset * 7 + Math.round(time * 1000));
  const data = new Uint8Array(width * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < width; x++) {
      let v: number;
      if (y < header) v = y < 4 ? 30 : x % 37 < 18 && y % 9 < 4 ? 20 : 235;
      else if (y >= H - footer) v = y === H - footer ? 120 : x % 50 < 20 && y % 11 < 5 ? 90 : 238;
      else {
        const py = Math.min(page.height - 1, Math.max(0, offset + (y - header)));
        v = page.data[py * width + x];
      }
      if (noise) v = Math.max(0, Math.min(255, v + Math.round((r() * 2 - 1) * noise)));
      data[y * width + x] = v;
    }
  }
  return { width, height: H, data, time };
}
