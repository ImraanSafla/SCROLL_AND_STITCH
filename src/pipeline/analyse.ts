/**
 * The analysis pipeline: works out where every useful frame sits on the
 * page. Compositing (Milestone 3) then copies the newly revealed strip of
 * each frame into the output.
 *
 * Pause-aware mode (default):
 *   1. Skim: tiny thumbnails at ~8 fps → motion timeline. Junk at the start
 *      and end (Control Centre, prompts) is trimmed off here.
 *   2. Static bands (header/footer) from the thumbnails, coarse.
 *   3. Pauses → anchor frames (sharp, blur-free), grabbed at full res.
 *   4. Static bands refined on the anchors.
 *   5. Offsets between consecutive anchors. Confident → done; no grabs in
 *      between. Otherwise split the gap where the motion is, grab the
 *      sharpest of a few frames there, and recurse.
 *   6. Anything still ambiguous: pick the candidate that best matches the
 *      recent scroll velocity.
 *
 * Naive mode (for comparison, per the brief): grab frames at a fixed rate
 * and match every consecutive pair.
 */
import { prepareFrame, matchFrames, refineOffset, type OffsetCandidate, type PreparedFrame, type Region } from '../engine/offset';
import { findPauses, motionMidpoint, autoThreshold, type MotionSample, type Pause } from '../engine/pauses';
import { rowSignatures } from '../engine/signatures';
import { coarseBands, refineBands, type StaticBands } from '../engine/static';
import { buildPlan, type Plan } from '../engine/compose';
import { findStableRange } from '../engine/junk';
import type { RowSignatures } from '../engine/signatures';
import { thumbDiff, type Thumb } from '../lib/thumb';
import type { FrameSource } from '../video/source';

export type Mode = 'pause-aware' | 'naive';

export interface AnalyseOptions {
  mode?: Mode;
  skimFps?: number;
  naiveFps?: number;
  minPause?: number;
  /** Matches at or above this confidence are accepted outright. */
  minConfidence?: number;
  /** How many times a gap may be split in half. */
  maxDepth?: number;
  /** Use only this time range (seconds), overriding automatic junk trimming. */
  trim?: { start: number; end: number };
}

export type PairKind = 'anchor' | 'gap' | 'naive';

export interface PairResult {
  from: number;
  to: number;
  offset: number;
  confidence: number;
  kind: PairKind;
  /** Chose a candidate by scroll velocity instead of best score. */
  byVelocity: boolean;
  candidates: OffsetCandidate[];
}

export interface PlacedFrame {
  time: number;
  /** Page position (px) of the top of the scrolling region. */
  position: number;
  sharpness: number;
  kind: 'anchor' | 'gap' | 'naive';
  /** Confidence of the join that placed this frame (1 for the first). */
  confidence: number;
  /** Full-res row signatures, used to choose seams. */
  sig: RowSignatures;
}

export interface Analysis {
  mode: Mode;
  source: FrameSource['kind'];
  width: number;
  height: number;
  duration: number;
  bands: StaticBands;
  coarseBands: StaticBands;
  region: Region;
  skim: { count: number; times: number[]; timeline: MotionSample[]; threshold: number };
  /** Content range used, and what junk detection suggested. */
  trim: { start: number; end: number; detectedStart: number; detectedEnd: number; duration: number };
  pauses: Pause[];
  frames: PlacedFrame[];
  pairs: PairResult[];
  timings: Record<string, number>;
  grabs: number;
  warnings: string[];
}

export type StageCallback = (stage: 'reading' | 'analysing' | 'matching', fraction: number) => void;

const DEFAULTS: Required<Omit<AnalyseOptions, 'trim'>> = {
  mode: 'pause-aware',
  skimFps: 8,
  naiveFps: 8,
  minPause: 0.2,
  minConfidence: 0.35,
  maxDepth: 5,
};

function timelineOf(thumbs: Thumb[]): MotionSample[] {
  return thumbs.slice(1).map((t, i) => ({ time: t.time, motion: thumbDiff(t, thumbs[i]) }));
}

export async function analyse(source: FrameSource, options: AnalyseOptions = {}, onStage?: StageCallback): Promise<Analysis> {
  const opts = { ...DEFAULTS, ...options };
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const t0 = performance.now();
  const lap = (name: string, since: number) => (timings[name] = Math.round(performance.now() - since));

  // 1. Skim.
  onStage?.('reading', 0);
  let t = performance.now();
  const allThumbs = await source.skim(opts.skimFps, (f) => onStage?.('reading', f));
  lap('skim', t);
  if (allThumbs.length < 2) {
    const err = new Error(
      allThumbs.length === 0
        ? `No frames came back from the ${source.kind === 'webcodecs' ? 'WebCodecs' : 'video'} reader.`
        : `Only one frame came back from the ${source.kind === 'webcodecs' ? 'WebCodecs' : 'video'} reader.`,
    );
    (err as Error & { readerFailed?: boolean }).readerFailed = true;
    throw err;
  }

  // Drop junk at the start and end.
  t = performance.now();
  const stable = findStableRange(allThumbs);
  const range = opts.trim ?? { start: stable.startTime, end: stable.endTime };
  let thumbs = allThumbs.filter((x) => x.time >= range.start - 1e-6 && x.time <= range.end + 1e-6);
  if (thumbs.length < 2) thumbs = allThumbs;
  const trimInfo = {
    start: thumbs[0].time,
    end: thumbs[thumbs.length - 1].time,
    detectedStart: stable.startTime,
    detectedEnd: stable.endTime,
    duration: source.duration,
  };
  if (stable.start > 0 || stable.end < allThumbs.length - 1) {
    warnings.push(`Ignored ${trimInfo.start.toFixed(2)} s at the start and ${(allThumbs[allThumbs.length - 1].time - trimInfo.end).toFixed(2)} s at the end.`);
  }
  lap('trim', t);
  const times = thumbs.map((x) => x.time);
  const timeline = timelineOf(thumbs);
  const threshold = autoThreshold(timeline);

  // 2. Coarse static bands from thumbnails.
  t = performance.now();
  const thumbSigs = thumbs.map((x) => rowSignatures({ width: x.width, height: x.height, data: x.gray }, 8));
  const coarse = coarseBands(thumbSigs, source.height);
  lap('staticCoarse', t);

  const region = (b: StaticBands): Region => ({ top: b.header, bottom: source.height - b.footer });
  const prepared = new Map<number, PreparedFrame>();
  const prep = async (ts: number[]) => {
    const need = ts.filter((x) => !prepared.has(x));
    if (!need.length) return ts.map((x) => prepared.get(x)!);
    const grabbed = await source.grab(need);
    need.forEach((x, i) => prepared.set(x, prepareFrame(grabbed[i])));
    return ts.map((x) => prepared.get(x)!);
  };

  let pauses: Pause[] = [];
  let pairs: PairResult[] = [];
  let bands = coarse;
  let chain: PreparedFrame[] = [];
  const anchorSet = new Set<PreparedFrame>();

  if (opts.mode === 'naive') {
    onStage?.('analysing', 0);
    t = performance.now();
    const ts: number[] = [];
    for (let x = trimInfo.start; x <= trimInfo.end + 1e-6; x += 1 / opts.naiveFps) ts.push(x);
    chain = await prep(ts);
    lap('grab', t);
    t = performance.now();
    bands = refineBands(chain.map((f) => f.fine), coarse, Math.ceil(source.height / thumbs[0].height) * 2);
    lap('staticRefine', t);
    onStage?.('matching', 0);
    t = performance.now();
    let velocity: number | null = null;
    for (let i = 1; i < chain.length; i++) {
      const p = pairOf(chain[i - 1], chain[i], region(bands), 'naive', velocity, opts.minConfidence);
      if (p.confidence >= opts.minConfidence && p.to > p.from) velocity = p.offset / (p.to - p.from);
      pairs.push(p);
      onStage?.('matching', i / chain.length);
    }
    lap('match', t);
  } else {
    // 3. Pauses → anchors. Within each pause, read a few frames and keep the
    // sharpest: video encoders keep refining a still screen, so frames later
    // in a pause tend to be crisper than the first ones.
    pauses = findPauses(times, timeline, { minDuration: opts.minPause, threshold });
    t = performance.now();
    const candidateTimes = pauses.map((p) => {
      const len = p.end - p.start;
      return [...new Set([p.anchor, p.start + len * 0.7, Math.max(p.start, p.end - 1 / 30)])];
    });
    const candidates = await prep(candidateTimes.flat());
    let ci = 0;
    pauses = pauses.map((p, i) => {
      const group = candidates.slice(ci, (ci += candidateTimes[i].length));
      const best = group.reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
      return { ...p, anchor: candidateTimes[i][group.indexOf(best)] };
    });
    lap('pickSharpest', t);
    const anchorTimes = pauses.map((p) => p.anchor);
    const movedBefore = (tt: number) => timeline.some((m) => m.time <= tt && m.motion > threshold);
    const movedAfter = (tt: number) => timeline.some((m) => m.time > tt && m.motion > threshold);
    if (!anchorTimes.length || movedBefore(pauses[0].start)) anchorTimes.unshift(times[0]);
    if (anchorTimes.length < 2 || movedAfter(pauses[pauses.length - 1]?.end ?? times[0])) {
      anchorTimes.push(times[times.length - 1]);
    }
    if (!pauses.length) warnings.push('No pauses found: sampling the scroll continuously.');

    onStage?.('analysing', 0);
    t = performance.now();
    const anchors = await prep(anchorTimes);
    anchors.forEach((f) => anchorSet.add(f));
    lap('grabAnchors', t);

    // 4. Refine static bands on the anchors.
    t = performance.now();
    if (anchors.length >= 2) {
      bands = refineBands(anchors.map((f) => f.fine), coarse, Math.ceil(source.height / thumbs[0].height) * 2);
    }
    lap('staticRefine', t);
    const reg = region(bands);

    // 5–6. Link anchors, filling gaps where needed.
    onStage?.('matching', 0);
    t = performance.now();
    let velocity: number | null = null;
    const gapStart = { ms: 0 };
    const link = async (a: PreparedFrame, b: PreparedFrame, depth: number, kind: PairKind): Promise<PreparedFrame[]> => {
      const res = pairOf(a, b, reg, kind, velocity, opts.minConfidence);
      const dt = b.time - a.time;
      if (res.confidence >= opts.minConfidence || depth >= opts.maxDepth || dt < 2.5 / 60) {
        if (res.confidence >= opts.minConfidence && dt > 0) velocity = res.offset / dt;
        pairs.push(res);
        return [b];
      }
      // Split the gap where the motion is and pick the sharpest nearby frame.
      const g0 = performance.now();
      const mid = motionMidpoint(timeline, a.time, b.time);
      const lo = a.time + 1 / 60;
      const hi = b.time - 1 / 60;
      const near = [mid - 1 / 30, mid, mid + 1 / 30].map((x) => Math.min(hi, Math.max(lo, x)));
      const cands = await prep([...new Set(near)]);
      const m = cands.reduce((best, c) => (c.sharpness > best.sharpness ? c : best));
      gapStart.ms += performance.now() - g0;
      if (m.time <= a.time || m.time >= b.time) {
        pairs.push(res);
        return [b];
      }
      const left = await link(a, m, depth + 1, 'gap');
      const right = await link(m, b, depth + 1, 'gap');
      return [...left, ...right];
    };
    chain = [anchors[0]];
    for (let i = 1; i < anchors.length; i++) {
      chain.push(...(await link(anchors[i - 1], anchors[i], 0, 'anchor')));
      onStage?.('matching', i / (anchors.length - 1));
    }
    lap('match', t);
    timings.gapGrabs = Math.round(gapStart.ms);
  }

  // Place frames on the page.
  const frames: PlacedFrame[] = [];
  let pos = 0;
  const pairByTo = new Map(pairs.map((p) => [p.to, p]));
  chain.forEach((f, i) => {
    const pair = i > 0 ? pairByTo.get(f.time) : undefined;
    if (pair) pos += pair.offset;
    frames.push({
      time: f.time,
      position: pos,
      sharpness: f.sharpness,
      kind: opts.mode === 'naive' ? 'naive' : anchorSet.has(f) ? 'anchor' : 'gap',
      confidence: pair ? pair.confidence : 1,
      sig: f.fine,
    });
  });
  const weak = pairs.filter((p) => p.confidence < opts.minConfidence).length;
  if (weak) warnings.push(`${weak} join(s) below the confidence threshold.`);

  timings.total = Math.round(performance.now() - t0);
  return {
    mode: opts.mode,
    source: source.kind,
    width: source.width,
    height: source.height,
    duration: source.duration,
    bands,
    coarseBands: coarse,
    region: region(bands),
    skim: { count: allThumbs.length, times, timeline, threshold },
    trim: trimInfo,
    pauses,
    frames,
    pairs,
    timings,
    grabs: prepared.size,
    warnings,
  };
}

/**
 * Match two frames. When the best match is weak, prefer the candidate whose
 * offset best fits the recent scroll velocity, if it scores nearly as well.
 */
function pairOf(
  a: PreparedFrame,
  b: PreparedFrame,
  region: Region,
  kind: PairKind,
  velocity: number | null,
  minConfidence: number,
): PairResult {
  const r = matchFrames(a, b, region);
  const base: PairResult = {
    from: a.time,
    to: b.time,
    offset: r.offset,
    confidence: r.confidence,
    kind,
    byVelocity: false,
    candidates: r.candidates,
  };
  if (r.confidence >= minConfidence || velocity === null || r.candidates.length < 2) return base;
  const predicted = velocity * (b.time - a.time);
  const best = r.candidates[0];
  const pick = r.candidates
    .filter((c) => c.cost <= best.cost + 3)
    .reduce((x, y) => (Math.abs(y.offset - predicted) < Math.abs(x.offset - predicted) ? y : x));
  if (pick.offset === best.offset) return base;
  const refined = refineOffset(a, b, region, pick.offset, a.factor + 1);
  return { ...base, offset: refined.offset, byVelocity: true };
}

/** Turn an analysis into a compositing plan. */
export function planFrom(a: Analysis): Plan {
  return buildPlan(
    a.frames.map((f) => ({
      time: f.time,
      position: f.position,
      sharpness: f.sharpness,
      confidence: f.confidence,
      // In naive mode every frame is a clean sample; treat them as anchors.
      anchor: f.kind !== 'gap',
      sig: f.sig,
    })),
    a.bands,
    a.width,
    a.height,
  );
}
