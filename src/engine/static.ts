/**
 * Static region detection: the status bar, navigation bars, Safari's address
 * and tab bars, the Dynamic Island, the home indicator. These rows look the
 * same in every frame while the content between them scrolls.
 *
 * A row is static if it barely changes across a set of frames taken at
 * different scroll positions. The header is the run of static rows from the
 * top, the footer the run from the bottom.
 *
 * Two passes: a coarse pass over many skim thumbnails (lots of scroll
 * positions, so blank page areas are unlikely to look static everywhere),
 * then a precise pass on a few full-resolution frames near the coarse edge.
 */
import { rowDistance, type RowSignatures } from './signatures';

export interface StaticBands {
  /** Rows of fixed header at the top (full-res). */
  header: number;
  /** Rows of fixed footer at the bottom (full-res). */
  footer: number;
}

/** Default tolerance in gray levels, allowing for compression noise. */
export const STATIC_TOLERANCE = 3;

/**
 * For each row, how much it changes between frames: the change from the
 * first frame, taken at the 75th percentile across frames once there are
 * enough of them (otherwise the maximum). The percentile ignores sporadic
 * compression flicker at a bar's edge, while scrolling content still
 * changes in most frames. Frames must have identical dimensions.
 */
export function rowVariation(sigs: RowSignatures[]): Float32Array {
  const rows = sigs[0].rows;
  const n = sigs.length - 1;
  const out = new Float32Array(rows);
  if (n <= 0) return out;
  const usePercentile = n >= 5;
  const col = new Float32Array(n);
  for (let y = 0; y < rows; y++) {
    for (let i = 1; i <= n; i++) col[i - 1] = rowDistance(sigs[0], y, sigs[i], y);
    if (usePercentile) {
      col.sort();
      out[y] = col[Math.min(n - 1, Math.floor(n * 0.75))];
    } else {
      let m = 0;
      for (let i = 0; i < n; i++) if (col[i] > m) m = col[i];
      out[y] = m;
    }
  }
  return out;
}

/** Runs of static rows from the top and bottom of a variation profile. */
export function bandsFromVariation(variation: Float32Array, tolerance = STATIC_TOLERANCE): StaticBands {
  const rows = variation.length;
  let header = 0;
  while (header < rows && variation[header] <= tolerance) header++;
  let footer = 0;
  while (footer < rows - header && variation[rows - 1 - footer] <= tolerance) footer++;
  if (header + footer >= rows) return { header: 0, footer: 0 }; // nothing moved at all
  return { header, footer };
}

/**
 * Coarse bands from thumbnails, scaled to full-res rows. The result is
 * rounded down (inward-safe) to whole thumbnail rows.
 */
export function coarseBands(thumbSigs: RowSignatures[], fullHeight: number, tolerance = STATIC_TOLERANCE): StaticBands {
  if (thumbSigs.length < 2) return { header: 0, footer: 0 };
  const b = bandsFromVariation(rowVariation(thumbSigs), tolerance);
  const scale = fullHeight / thumbSigs[0].rows;
  return { header: Math.floor(b.header * scale), footer: Math.floor(b.footer * scale) };
}

/**
 * Refine coarse bands using full-resolution signatures. Searches a window
 * of ±`window` rows around each coarse edge.
 */
export function refineBands(
  fullSigs: RowSignatures[],
  coarse: StaticBands,
  window: number,
  tolerance = STATIC_TOLERANCE,
): StaticBands {
  if (fullSigs.length < 2) return coarse;
  const v = rowVariation(fullSigs);
  const rows = v.length;
  const refineEdge = (start: number, dir: 1 | -1, coarseLen: number) => {
    // Walk outward from the safe interior of the band towards the content,
    // stopping at the first row that moves.
    let len = Math.max(0, coarseLen - window);
    const limit = Math.min(rows, coarseLen + window);
    while (len < limit) {
      const y = dir === 1 ? start + len : start - len;
      if (v[y] > tolerance) break;
      len++;
    }
    // If the interior itself moves, shrink back until it does not.
    while (len > 0) {
      const y = dir === 1 ? start + len - 1 : start - (len - 1);
      if (v[y] <= tolerance) break;
      len--;
    }
    return len;
  };
  const header = coarse.header > 0 ? refineEdge(0, 1, coarse.header) : 0;
  const footer = coarse.footer > 0 ? refineEdge(rows - 1, -1, coarse.footer) : 0;
  if (header + footer >= rows) return coarse;
  return { header, footer };
}
