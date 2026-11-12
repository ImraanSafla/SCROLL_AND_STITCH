/**
 * Vertical offset estimation between two frames.
 *
 * Convention: offset d means row y of frame B shows the same content as
 * row y + d of frame A. Scrolling down gives d > 0, scrolling back d < 0.
 * If A sits at page position p, B sits at p + d.
 *
 * Coarse to fine:
 * 1. Coarse: row signatures of 4× downscaled frames, exhaustive search over
 *    every offset that leaves a minimum overlap. Cost per offset is a
 *    trimmed mean of row distances, so a GIF, video or sticky element that
 *    covers part of the overlap cannot dominate the score.
 * 2. Fine: full-resolution signatures, searching only ±(factor + 1) rows
 *    around the coarse winner. Trimming would discard exactly the edge rows
 *    that pin down the last few pixels, so the fine step instead caps each
 *    row's error: an animated patch adds the same capped cost to every
 *    candidate, while text edges still separate them.
 *
 * Confidence combines how clearly the best offset beats the next-best
 * distinct offset, how well it fits in absolute terms, and how much
 * texture the overlap has (blank areas match anything).
 */
import { downscale, type GrayFrame, type GrayImage } from './gray';
import { rowDistance, rowSignatures, texture, type RowSignatures } from './signatures';

export interface Region {
  /** First row of the scrolling area (full-res). */
  top: number;
  /** One past the last row of the scrolling area (full-res). */
  bottom: number;
}

export interface PreparedFrame {
  time: number;
  width: number;
  height: number;
  factor: number;
  coarse: RowSignatures;
  fine: RowSignatures;
  /** Gradient energy at full resolution; lower means blurrier. */
  sharpness: number;
}

export interface OffsetCandidate {
  offset: number;
  cost: number;
}

export interface OffsetResult {
  offset: number;
  cost: number;
  confidence: number;
  /** Distinct coarse candidates (full-res offsets), best first. */
  candidates: OffsetCandidate[];
  overlapRows: number;
  texture: number;
}

export interface MatchOptions {
  /** Smallest overlap allowed, as a fraction of the region height. */
  minOverlapFrac?: number;
  /** Fraction of worst-matching rows ignored. */
  trim?: number;
  /** Restrict the search to this offset range (full-res rows). */
  minOffset?: number;
  maxOffset?: number;
}

export const COARSE_FACTOR = 4;
const COARSE_BANDS = 8;
const FINE_BANDS = 24;
/** Per-row error cap for the fine step, in gray levels. */
const FINE_CAP = 24;
const DEFAULTS = { minOverlapFrac: 0.05, trim: 0.2 };

/**
 * Sharpness: mean gradient energy (horizontal + vertical) over the middle
 * 80% of the frame, sampled every `step` pixels. Measured at full
 * resolution, because compression softness lives in the finest detail that
 * downscaling would average away. Motion blur lowers the vertical part.
 */
export function sharpnessOf(img: GrayImage, step = 2): number {
  const { width, height, data } = img;
  const y0 = Math.floor(height * 0.1);
  const y1 = Math.floor(height * 0.9);
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1 - 1; y += step) {
    const r = y * width;
    for (let x = 0; x < width - 1; x += step) {
      const p = r + x;
      s += Math.abs(data[p] - data[p + width]) + Math.abs(data[p] - data[p + 1]);
      n++;
    }
  }
  return n ? s / n : 0;
}

export function prepareFrame(img: GrayFrame, factor = COARSE_FACTOR): PreparedFrame {
  const small = downscale(img, factor);
  return {
    time: img.time,
    width: img.width,
    height: img.height,
    factor,
    coarse: rowSignatures(small, COARSE_BANDS),
    fine: rowSignatures(img, FINE_BANDS),
    sharpness: sharpnessOf(img),
  };
}

/**
 * Trimmed-mean cost of offset d over rows [top, bottom) and the overlap size.
 * `scratch` must hold at least bottom - top floats.
 */
export function offsetCost(
  a: RowSignatures,
  b: RowSignatures,
  top: number,
  bottom: number,
  d: number,
  trim: number,
  scratch: Float32Array,
): { cost: number; n: number } {
  const y0 = Math.max(top, top - d);
  const y1 = Math.min(bottom, bottom - d);
  const n = y1 - y0;
  if (n <= 0) return { cost: Infinity, n: 0 };
  for (let y = y0, i = 0; y < y1; y++, i++) scratch[i] = rowDistance(b, y, a, y + d);
  const view = scratch.subarray(0, n);
  view.sort();
  const keep = Math.max(1, Math.round(n * (1 - trim)));
  let s = 0;
  for (let i = 0; i < keep; i++) s += view[i];
  return { cost: s / keep, n };
}

/** Mean of per-row errors, each capped at `cap`. Used for the fine step. */
export function cappedCost(
  a: RowSignatures,
  b: RowSignatures,
  top: number,
  bottom: number,
  d: number,
  cap: number,
): { cost: number; n: number } {
  const y0 = Math.max(top, top - d);
  const y1 = Math.min(bottom, bottom - d);
  const n = y1 - y0;
  if (n <= 0) return { cost: Infinity, n: 0 };
  let s = 0;
  for (let y = y0; y < y1; y++) s += Math.min(cap, rowDistance(b, y, a, y + d));
  return { cost: s / n, n };
}

/**
 * Penalise small overlaps: a few blank rows match perfectly by chance, so
 * among near-perfect matches the one with more overlap should win. The
 * penalty is additive (in gray levels), because a multiplicative one does
 * nothing when the chance match costs zero.
 */
export const OVERLAP_PENALTY = 2.5;
function adjusted(cost: number, n: number, regionRows: number) {
  return cost + OVERLAP_PENALTY * (1 - n / regionRows);
}

function coarseRegion(region: Region, factor: number, rows: number) {
  return {
    top: Math.min(rows, Math.ceil(region.top / factor)),
    bottom: Math.min(rows, Math.floor(region.bottom / factor)),
  };
}

/** Exhaustive coarse search. Returns cost per offset (index = d - dMin). */
function coarseScan(a: PreparedFrame, b: PreparedFrame, region: Region, opts: Required<MatchOptions>) {
  const f = a.factor;
  const { top, bottom } = coarseRegion(region, f, Math.min(a.coarse.rows, b.coarse.rows));
  const R = bottom - top;
  const minOverlap = Math.max(4, Math.round(R * opts.minOverlapFrac));
  const dMin = Math.max(-(R - minOverlap), Math.ceil(opts.minOffset / f));
  const dMax = Math.min(R - minOverlap, Math.floor(opts.maxOffset / f));
  const costs = new Float32Array(Math.max(0, dMax - dMin + 1)).fill(Infinity);
  const scratch = new Float32Array(R);
  for (let d = dMin; d <= dMax; d++) {
    const { cost, n } = offsetCost(a.coarse, b.coarse, top, bottom, d, opts.trim, scratch);
    costs[d - dMin] = adjusted(cost, n, R);
  }
  return { costs, dMin, top, bottom, R };
}

/** Local minima of the cost curve, best first, at least `sep` apart. */
function localMinima(costs: Float32Array, dMin: number, sep: number, limit: number) {
  const mins: { d: number; cost: number }[] = [];
  for (let i = 0; i < costs.length; i++) {
    const c = costs[i];
    if (!Number.isFinite(c)) continue;
    if (i > 0 && costs[i - 1] < c) continue;
    if (i < costs.length - 1 && costs[i + 1] < c) continue;
    mins.push({ d: i + dMin, cost: c });
  }
  mins.sort((x, y) => x.cost - y.cost);
  const out: typeof mins = [];
  for (const m of mins) {
    if (out.every((o) => Math.abs(o.d - m.d) > sep)) out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** Refine a full-res offset guess by searching ±radius rows at full resolution. */
export function refineOffset(
  a: PreparedFrame,
  b: PreparedFrame,
  region: Region,
  guess: number,
  radius: number,
  cap = FINE_CAP,
): OffsetCandidate {
  const top = region.top;
  const bottom = Math.min(region.bottom, a.fine.rows, b.fine.rows);
  const R = bottom - top;
  let best: OffsetCandidate = { offset: guess, cost: Infinity };
  for (let d = guess - radius; d <= guess + radius; d++) {
    if (Math.abs(d) >= R) continue;
    const { cost, n } = cappedCost(a.fine, b.fine, top, bottom, d, cap);
    const c = adjusted(cost, n, R);
    if (c < best.cost) best = { offset: d, cost: c };
  }
  return best;
}

export function confidenceOf(best: number, second: number, tex: number, rawBest = best): number {
  const separation = Number.isFinite(second) ? Math.max(0, (second - best) / (second + 1)) : 1;
  const fit = Math.min(1, Math.max(0, 1.25 - rawBest / 8));
  const textured = Math.min(1, tex / 3);
  return separation * fit * textured;
}

export function matchFrames(a: PreparedFrame, b: PreparedFrame, region: Region, options: MatchOptions = {}): OffsetResult {
  const opts: Required<MatchOptions> = {
    ...DEFAULTS,
    minOffset: -Infinity,
    maxOffset: Infinity,
    ...options,
  };
  const f = a.factor;
  const scan = coarseScan(a, b, region, opts);
  const mins = localMinima(scan.costs, scan.dMin, 3, 6);
  if (!mins.length) {
    return { offset: 0, cost: Infinity, confidence: 0, candidates: [], overlapRows: 0, texture: 0 };
  }
  const [best, second] = mins;
  const y0 = Math.max(scan.top, scan.top - best.d);
  const y1 = Math.min(scan.bottom, scan.bottom - best.d);
  const tex = texture(b.coarse, y0, y1);
  // Fit is judged on the raw cost (without the overlap penalty); separation
  // on the penalised costs, so chance matches on tiny overlaps count less.
  const raw = offsetCost(a.coarse, b.coarse, scan.top, scan.bottom, best.d, opts.trim, new Float32Array(scan.R)).cost;
  const confidence = confidenceOf(best.cost, second?.cost ?? Infinity, tex, raw);
  const fine = refineOffset(a, b, region, best.d * f, f + 1);
  return {
    offset: fine.offset,
    cost: fine.cost,
    confidence,
    candidates: mins.map((m) => ({ offset: m.d * f, cost: m.cost })),
    overlapRows: (y1 - y0) * f,
    texture: tex,
  };
}
