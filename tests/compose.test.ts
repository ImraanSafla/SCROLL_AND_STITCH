import { describe, expect, it } from 'vitest';
import { buildPlan, type PlanFrame } from '../src/engine/compose';
import { downscale } from '../src/engine/gray';
import { findStableRange } from '../src/engine/junk';
import { findRecordingPill, paintOver } from '../src/engine/pill';
import { rowSignatures } from '../src/engine/signatures';
import type { Thumb } from '../src/lib/thumb';
import { makeFrame, makePage } from './synthetic';

const W = 240;
const H = 520;
const spec = { frameHeight: H, header: 60, footer: 50 };
const R = H - spec.header - spec.footer;
const page = makePage(W, 4000, 5);

function planFrame(position: number, time: number, anchor = true, confidence = 1): PlanFrame {
  const f = makeFrame(page, position, spec, time);
  return { time, position, sharpness: 10, confidence, anchor, sig: rowSignatures(f, 24) };
}

function covered(plan: ReturnType<typeof buildPlan>) {
  const segs = [...plan.segments].sort((a, b) => a.dstY - b.dstY);
  let y = plan.header.rows;
  for (const s of segs) {
    expect(s.dstY).toBe(y);
    y += s.rows;
  }
  return y + plan.footer.rows;
}

describe('compositing plan', () => {
  it('covers the page exactly once with one seam per join', () => {
    const plan = buildPlan([planFrame(0, 0), planFrame(300, 1), planFrame(650, 2)], spec, W, H);
    expect(plan.height).toBe(spec.header + 650 + R + spec.footer);
    expect(covered(plan)).toBe(plan.height);
    expect(plan.seams.length).toBe(2);
    expect(plan.gaps.length).toBe(0);
    // Each segment copies page rows that match the output row.
    for (const s of plan.segments) {
      const f = [0, 300, 650][[0, 1, 2].indexOf(s.time)];
      const pageRow = s.srcY - spec.header + f;
      expect(pageRow).toBe(s.dstY - spec.header);
    }
  });

  it('cuts seams inside the overlap', () => {
    const plan = buildPlan([planFrame(0, 0), planFrame(300, 1)], spec, W, H);
    const seamPage = plan.seams[0].y - spec.header;
    expect(seamPage).toBeGreaterThan(300);
    expect(seamPage).toBeLessThan(R);
  });

  it('handles scrolling backwards (frames out of time order)', () => {
    const plan = buildPlan([planFrame(600, 0), planFrame(900, 1), planFrame(300, 2), planFrame(0, 3)], spec, W, H);
    expect(plan.height).toBe(spec.header + 900 + R + spec.footer);
    expect(covered(plan)).toBe(plan.height);
    expect(plan.header.time).toBe(0);
  });

  it('flags a gap instead of faking a join', () => {
    const plan = buildPlan([planFrame(0, 0), planFrame(R + 200, 1)], spec, W, H);
    expect(plan.gaps.length).toBe(1);
    expect(plan.gaps[0].missing).toBe(200);
    expect(plan.seams.length).toBe(0);
    expect(covered(plan)).toBe(plan.height);
    expect(plan.height).toBe(spec.header + 2 * R + spec.footer);
  });

  it('drops frames that add nothing and rubber-band overscroll', () => {
    // A duplicate of the first position, and an overscroll past the last anchor.
    const frames = [planFrame(0, 0), planFrame(0, 0.5, false), planFrame(400, 1), planFrame(480, 1.2, false)];
    const plan = buildPlan(frames, spec, W, H);
    expect(plan.height).toBe(spec.header + 400 + R + spec.footer);
    expect(plan.dropped).toBeGreaterThanOrEqual(2);
  });
});

describe('junk detection', () => {
  const toThumb = (f: ReturnType<typeof makeFrame>, time: number): Thumb => {
    const g = downscale(f, 4);
    return { time, width: g.width, height: g.height, gray: g.data };
  };
  const content = Array.from({ length: 30 }, (_, i) => toThumb(makeFrame(page, i * 40, spec, i), 0.6 + i / 8));
  const dim = (t: Thumb, k: number, time: number): Thumb => ({ ...t, time, gray: t.gray.map((v) => Math.round(v * k)) });

  it('drops a dimmed start and end, keeps the content', () => {
    const lead = [0, 1, 2, 3].map((i) => dim(content[0], 0.25 + i * 0.12, i / 8));
    const tail = [0, 1, 2].map((i) => dim(content[29], 0.55, 4.5 + i / 8));
    const r = findStableRange([...lead, ...content, ...tail]);
    expect(r.start).toBe(4);
    expect(r.end).toBe(4 + 29);
  });

  it('forgives a single odd frame in the middle', () => {
    const frames = [...content];
    frames[12] = dim(frames[12], 0.5, frames[12].time);
    const r = findStableRange(frames);
    expect(r.start).toBe(0);
    expect(r.end).toBe(29);
  });

  it('keeps everything when the recording is clean', () => {
    const r = findStableRange(content);
    expect([r.start, r.end]).toEqual([0, 29]);
  });
});

describe('recording pill', () => {
  const w = 300;
  const h = 60;
  const img = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) img.set([245, 245, 247, 255], i * 4);
  for (let y = 12; y < 40; y++) for (let x = 20; x < 90; x++) img.set([255, 59, 48, 255], (y * w + x) * 4);
  for (let y = 20; y < 30; y++) for (let x = 40; x < 60; x++) img.set([255, 255, 255, 255], (y * w + x) * 4);

  it('finds the red pill and paints it with the surrounding colour', () => {
    const r = findRecordingPill(img, w, h);
    expect(r).not.toBeNull();
    expect(r!.x).toBe(20);
    expect(r!.w).toBe(70);
    const copy = img.slice();
    paintOver(copy, w, h, r!);
    expect(findRecordingPill(copy, w, h)).toBeNull();
    const p = (25 * w + 50) * 4;
    expect([copy[p], copy[p + 1], copy[p + 2]]).toEqual([245, 245, 247]);
  });

  it('ignores scattered red pixels', () => {
    const noisy = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) noisy.set(i % 97 === 0 ? [255, 40, 40, 255] : [250, 250, 250, 255], i * 4);
    expect(findRecordingPill(noisy, w, h)).toBeNull();
  });
});
