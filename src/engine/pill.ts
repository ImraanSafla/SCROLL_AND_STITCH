/**
 * The red screen-recording indicator. iOS draws it behind the clock (or as a
 * red dot near the Dynamic Island) in every frame of a recording, so it
 * would end up in the final screenshot's status bar. We find the saturated
 * red blob in the status-bar rows and paint it over with the colour around
 * it. The clock inside the pill goes with it; the UI offers "Keep status
 * bar" for anyone who prefers the original.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const isRecordingRed = (r: number, g: number, b: number) => r > 190 && g < 120 && b < 120 && r - g > 100 && r - b > 100;

/**
 * Find the recording indicator within the first `rows` rows of an RGBA
 * image `width` pixels wide. Returns null if there is none.
 */
export function findRecordingPill(rgba: Uint8ClampedArray | Uint8Array, width: number, rows: number): Rect | null {
  let x0 = width;
  let y0 = rows;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (isRecordingRed(rgba[p], rgba[p + 1], rgba[p + 2])) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count === 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // Solid-ish blob of a plausible size; scattered red pixels (a red web
  // page tint, a photo) are not the indicator.
  if (w < 10 || h < 10 || w > width * 0.4 || count < 0.4 * w * h) return null;
  return { x: x0, y: y0, w, h };
}

/**
 * Paint over `rect` (grown by `pad` px) with the median colour of a thin
 * ring just outside it. Modifies `rgba` in place.
 */
export function paintOver(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, rect: Rect, pad = 4) {
  const x0 = Math.max(0, rect.x - pad);
  const y0 = Math.max(0, rect.y - pad);
  const x1 = Math.min(width, rect.x + rect.w + pad);
  const y1 = Math.min(height, rect.y + rect.h + pad);
  const ring = 6;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = Math.max(0, y0 - ring); y < Math.min(height, y1 + ring); y++) {
    for (let x = Math.max(0, x0 - ring); x < Math.min(width, x1 + ring); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const p = (y * width + x) * 4;
      rs.push(rgba[p]);
      gs.push(rgba[p + 1]);
      bs.push(rgba[p + 2]);
    }
  }
  const med = (a: number[]) => (a.sort((m, n) => m - n), a[a.length >> 1] ?? 0);
  const r = med(rs);
  const g = med(gs);
  const b = med(bs);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4;
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    }
  }
}
