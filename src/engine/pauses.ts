/**
 * Motion timeline and pause detection for the cheap skim pass.
 *
 * People making a screenshot scroll, stop, scroll, stop. Frames in the
 * middle of a stop are sharp and blur-free, so they become "anchors".
 */

export interface MotionSample {
  /** Time of the later frame of the pair. */
  time: number;
  /** Mean absolute thumbnail difference from the previous frame, 0–255. */
  motion: number;
}

export interface Pause {
  start: number;
  end: number;
  /** Time chosen as the anchor frame. */
  anchor: number;
}

export interface PauseOptions {
  /** Minimum stillness to count as a pause, in seconds. */
  minDuration?: number;
  /** Motion below this counts as still. Auto-detected if omitted. */
  threshold?: number;
}

/** Noise-aware stillness threshold: a little above the quietest motion. */
export function autoThreshold(timeline: MotionSample[]): number {
  if (!timeline.length) return 0.5;
  const sorted = timeline.map((m) => m.motion).sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.2)];
  return Math.max(0.35, quiet * 2.5 + 0.2);
}

/**
 * Find pauses. `times` are the timestamps of the skim frames, in order; the
 * timeline has one entry per frame after the first.
 */
export function findPauses(times: number[], timeline: MotionSample[], options: PauseOptions = {}): Pause[] {
  const minDuration = options.minDuration ?? 0.2;
  const threshold = options.threshold ?? autoThreshold(timeline);
  const pauses: Pause[] = [];
  // still[i] says whether frame i equals frame i-1; frame 0 inherits frame 1.
  const n = times.length;
  const still = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) still[i] = timeline[i - 1].motion <= threshold;
  if (n > 1) still[0] = still[1];
  let i = 0;
  while (i < n) {
    if (!still[i]) {
      i++;
      continue;
    }
    // A pause spans frames [s, e] where every consecutive pair is still.
    const s = i > 0 && still[i] ? i - 1 : i;
    let e = i;
    while (e + 1 < n && still[e + 1]) e++;
    const start = times[s];
    const end = times[e];
    if (end - start >= minDuration - 1e-6) {
      const mid = times[Math.round((s + e) / 2)];
      pauses.push({ start, end, anchor: mid });
    }
    i = e + 1;
  }
  return pauses;
}

/**
 * Time at which half of the motion between t0 and t1 has happened. Used to
 * split a gap where the scroll actually is, not just at the clock midpoint.
 */
export function motionMidpoint(timeline: MotionSample[], t0: number, t1: number): number {
  const inside = timeline.filter((m) => m.time > t0 && m.time <= t1);
  const total = inside.reduce((s, m) => s + m.motion, 0);
  if (total <= 0) return (t0 + t1) / 2;
  let acc = 0;
  for (const m of inside) {
    acc += m.motion;
    if (acc >= total / 2) return Math.min(t1, Math.max(t0, m.time));
  }
  return (t0 + t1) / 2;
}
