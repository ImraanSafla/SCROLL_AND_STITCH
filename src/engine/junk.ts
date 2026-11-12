/**
 * Junk detection: the first and last moments of a screen recording often
 * show Control Centre closing, a dimmed screen, the stop-recording prompt or
 * another app. We find the main stretch of real content and drop the rest.
 *
 * Signal: the status-bar strip at the top of the screen. While the content
 * is on screen it stays put (time, battery, island); Control Centre, dimming
 * and prompts all change it. The bottom of the screen is deliberately not
 * used, because Safari's toolbar shrinks and grows while scrolling.
 *
 * A single odd frame inside good ones is forgiven (a notification flicker),
 * then the longest run of good frames wins.
 */
import type { Thumb } from '../lib/thumb';

export interface StableRange {
  /** Indices into the thumbnail list, inclusive. */
  start: number;
  end: number;
  startTime: number;
  endTime: number;
  /** Per-thumbnail score: mean status-bar difference from the typical frame. */
  scores: number[];
  threshold: number;
}

/** Fraction of the frame height treated as the status-bar strip. */
export const STATUS_STRIP = 0.04;

export function findStableRange(thumbs: Thumb[]): StableRange {
  const n = thumbs.length;
  if (n === 0) return { start: 0, end: -1, startTime: 0, endTime: 0, scores: [], threshold: 0 };
  const { width, height } = thumbs[0];
  const rows = Math.max(2, Math.ceil(height * STATUS_STRIP));
  const len = rows * width;

  // Typical status bar: per-pixel median across all frames. Robust as long
  // as junk is less than half of the video.
  const median = new Uint8Array(len);
  const col = new Uint8Array(n);
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < n; k++) col[k] = thumbs[k].gray[i];
    col.sort();
    median[i] = col[n >> 1];
  }
  const scores = thumbs.map((t) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Math.abs(t.gray[i] - median[i]);
    return s / len;
  });
  const sorted = [...scores].sort((a, b) => a - b);
  const typical = sorted[Math.floor(n * 0.5)];
  const threshold = Math.max(4, typical * 3);
  const bad = scores.map((s) => s > threshold);
  // Forgive isolated bad frames.
  const isBad = bad.map((b, i) => b && ((i > 0 && bad[i - 1]) || (i < n - 1 && bad[i + 1]) || n === 1));

  let best = { start: 0, end: -1 };
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && !isBad[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - 1 - runStart > best.end - best.start) best = { start: runStart, end: i - 1 };
      runStart = -1;
    }
  }
  if (best.end < 0) best = { start: 0, end: n - 1 }; // everything looked odd: keep it all
  return {
    ...best,
    startTime: thumbs[best.start].time,
    endTime: thumbs[best.end].time,
    scores,
    threshold,
  };
}
