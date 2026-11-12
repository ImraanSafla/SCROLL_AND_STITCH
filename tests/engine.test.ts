import { describe, expect, it } from 'vitest';
import { matchFrames, prepareFrame, type Region } from '../src/engine/offset';
import { coarseBands, refineBands } from '../src/engine/static';
import { findPauses, motionMidpoint, type MotionSample } from '../src/engine/pauses';
import { downscale } from '../src/engine/gray';
import { rowSignatures } from '../src/engine/signatures';
import { makeFrame, makePage } from './synthetic';

const W = 240;
const H = 520;
const spec = { frameHeight: H, header: 60, footer: 50 };
const region: Region = { top: spec.header, bottom: H - spec.footer };
const viewRows = H - spec.header - spec.footer; // 410
const page = makePage(W, 4000, 3, [2400, 2900]);

function match(o1: number, o2: number, noise = 0) {
  const a = prepareFrame(makeFrame(page, o1, { ...spec, noise }, 0));
  const b = prepareFrame(makeFrame(page, o2, { ...spec, noise }, 1));
  return matchFrames(a, b, region);
}

describe('offset estimation', () => {
  it.each([0, 1, 7, 37, 120, 205, 330])('finds a downward scroll of %i px exactly', (d) => {
    const r = match(500, 500 + d);
    expect(r.offset).toBe(d);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it.each([-15, -140, -300])('finds a backward scroll of %i px', (d) => {
    const r = match(1500, 1500 + d);
    expect(r.offset).toBe(d);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('handles scrolls of 80–90% of the view, and is never confidently wrong', () => {
    let exact = 0;
    const starts = [300, 800, 1200, 1700, 3000, 3300];
    for (const start of starts) {
      for (const frac of [0.8, 0.9]) {
        const d = Math.round(viewRows * frac);
        const r = match(start, start + d);
        if (r.offset === d) exact++;
        else expect(r.confidence).toBeLessThan(0.3);
      }
    }
    expect(exact).toBeGreaterThanOrEqual(starts.length * 2 - 3);
  });

  it('tolerates compression-like pixel noise', () => {
    for (const d of [13, 150, 260]) {
      const r = match(1000, 1000 + d, 6);
      expect(r.offset).toBe(d);
      expect(r.confidence).toBeGreaterThan(0.3);
    }
  });

  it('reports low confidence when frames do not overlap', () => {
    const r = match(200, 200 + viewRows + 300);
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('reports low confidence inside a large blank area', () => {
    // Both frames sit entirely inside the 500 px blank stretch.
    const r = match(2420, 2460);
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('ignores a small animated patch thanks to the trimmed cost', () => {
    const a = makeFrame(page, 700, spec, 0);
    const b = makeFrame(page, 790, spec, 1);
    // Scribble over 12% of the scrolling rows in B, like a playing GIF.
    for (let y = 300; y < 350; y++) for (let x = 30; x < 200; x++) b.data[y * W + x] = (x * 13 + y * 7) & 255;
    const r = matchFrames(prepareFrame(a), prepareFrame(b), region);
    expect(r.offset).toBe(90);
  });

  it('offers alternative candidates for the velocity prior', () => {
    const r = match(500, 600);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0].offset).toBeCloseTo(100, -1);
  });
});

describe('static region detection', () => {
  const frames = [0, 140, 333, 610, 900, 1210, 1500, 1830].map((o, i) => makeFrame(page, o, { ...spec, noise: 2 }, i));

  it('finds header and footer from thumbnails, then refines to the exact row', () => {
    const thumbs = frames.map((f) => rowSignatures(downscale(f, 4), 8));
    const coarse = coarseBands(thumbs, H);
    expect(Math.abs(coarse.header - spec.header)).toBeLessThanOrEqual(8);
    expect(Math.abs(coarse.footer - spec.footer)).toBeLessThanOrEqual(8);
    const full = frames.slice(0, 4).map((f) => rowSignatures(f, 24));
    const fine = refineBands(full, coarse, 12);
    expect(fine.header).toBe(spec.header);
    expect(fine.footer).toBe(spec.footer);
  });

  it('returns no bands when nothing scrolled', () => {
    const still = [0, 1, 2].map((t) => rowSignatures(makeFrame(page, 300, spec, t), 8));
    expect(coarseBands(still, H)).toEqual({ header: 0, footer: 0 });
  });
});

describe('pause detection', () => {
  // 8 fps skim: still 0–0.75 s, scroll until 1.5 s, still until 2.25 s, scroll, still from 3 s.
  const times = Array.from({ length: 30 }, (_, i) => i / 8);
  const motionAt = (t: number) => (t > 0.75 && t <= 1.5) || (t > 2.25 && t <= 3) ? 12 : 0.1;
  const timeline: MotionSample[] = times.slice(1).map((t) => ({ time: t, motion: motionAt(t) }));

  it('finds each pause and anchors in its middle', () => {
    const p = findPauses(times, timeline);
    expect(p.length).toBe(3);
    expect(p[0].start).toBe(0);
    expect(p[0].anchor).toBeGreaterThan(0.2);
    expect(p[0].anchor).toBeLessThan(0.6);
    expect(p[1].anchor).toBeGreaterThan(1.5);
    expect(p[1].anchor).toBeLessThan(2.25);
  });

  it('ignores stillness shorter than the minimum', () => {
    const p = findPauses(times, timeline, { minDuration: 0.8 });
    expect(p.every((x) => x.end - x.start >= 0.8 - 1e-6)).toBe(true);
  });

  it('splits gaps where the motion is', () => {
    const t = motionMidpoint(timeline, 0, 3);
    expect(t).toBeGreaterThan(1.3);
    expect(t).toBeLessThan(2.5);
  });
});
