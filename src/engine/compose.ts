/**
 * Compositing plan: decides which frame supplies each row of the output.
 *
 * Frames are placed on the page by the analysis (position = page row shown
 * at the top of the scrolling region). Sorted by position, each frame
 * supplies the page rows between the seam above it and the seam below it.
 *
 * Seams are cut where the two neighbouring frames agree best and the
 * content is quiet (a blank row between paragraphs rather than through a
 * line of text), so joins are invisible. We cut rather than blend: blending
 * two slightly different frames ghosts text.
 *
 * The output is: header (once, from the earliest frame), the page, footer
 * (once, from the same frame). Gaps, where neighbouring frames do not
 * overlap at all, are never faked: they are recorded so the UI can flag
 * them.
 */
import type { Region } from './offset';
import { rowDistance, type RowSignatures } from './signatures';
import type { StaticBands } from './static';

export interface PlanFrame {
  time: number;
  position: number;
  sharpness: number;
  /** Confidence of the join that placed this frame (1 for the first). */
  confidence: number;
  anchor: boolean;
  /** Full-resolution row signatures of the whole frame. */
  sig: RowSignatures;
}

export interface Segment {
  /** Frame time to copy rows from. */
  time: number;
  /** First source row within the frame. */
  srcY: number;
  /** First destination row in the output. */
  dstY: number;
  rows: number;
}

export interface Seam {
  /** Output row where the lower frame takes over. */
  y: number;
  confidence: number;
  above: number;
  below: number;
}

export interface Gap {
  /** Output row where the missing stretch would be. */
  y: number;
  /** Page rows that no frame showed. */
  missing: number;
  above: number;
  below: number;
}

export interface Plan {
  width: number;
  height: number;
  frameHeight: number;
  header: Segment;
  footer: Segment;
  segments: Segment[];
  seams: Seam[];
  gaps: Gap[];
  /** Frames left out (fully covered by others, or rubber-band overscroll). */
  dropped: number;
}

export function buildPlan(
  frames: PlanFrame[],
  bands: StaticBands,
  frameWidth: number,
  frameHeight: number,
): Plan {
  if (!frames.length) throw new Error('No frames to stitch');
  const region: Region = { top: bands.header, bottom: frameHeight - bands.footer };
  const R = region.bottom - region.top;

  // Rubber-band overscroll: frames scrolled beyond where the user came to
  // rest at either end show stretched blank space. With anchors at both
  // ends, keep only frames within the anchors' range.
  const anchors = frames.filter((f) => f.anchor);
  let usable = frames;
  if (anchors.length >= 2) {
    const lo = Math.min(...anchors.map((f) => f.position));
    const hi = Math.max(...anchors.map((f) => f.position));
    usable = frames.filter((f) => f.position >= lo && f.position <= hi);
  }

  // Sort by position; for duplicates keep the sharpest (anchors first).
  const sorted = [...usable].sort((a, b) => a.position - b.position || Number(b.anchor) - Number(a.anchor) || b.sharpness - a.sharpness);
  const unique: PlanFrame[] = [];
  for (const f of sorted) {
    const last = unique[unique.length - 1];
    if (last && Math.abs(last.position - f.position) < 1) continue;
    unique.push(f);
  }

  const pageTop = unique[0].position;
  const kept: PlanFrame[] = [unique[0]];
  const cuts: number[] = []; // page row where kept[i+1] takes over from kept[i]
  const gaps: { at: number; missing: number; above: PlanFrame; below: PlanFrame }[] = [];
  for (let i = 1; i < unique.length; i++) {
    const a = kept[kept.length - 1];
    const b = unique[i];
    const aEnd = a.position + R;
    const bEnd = b.position + R;
    const prevCut = cuts.length ? cuts[cuts.length - 1] : pageTop;
    if (bEnd <= aEnd) continue; // b adds nothing below a
    if (b.position >= aEnd) {
      // No overlap: a true gap. Place b directly after a.
      gaps.push({ at: aEnd, missing: b.position - aEnd, above: a, below: b });
      cuts.push(aEnd);
      kept.push(b);
      continue;
    }
    const overlap = aEnd - b.position;
    const margin = Math.min(8, Math.floor(overlap / 4));
    const lo = Math.max(prevCut + 1, b.position + margin);
    const hi = aEnd - margin;
    let cut: number;
    if (lo > hi) {
      cut = Math.max(prevCut + 1, b.position);
    } else {
      const mid = (lo + hi) / 2;
      let best = Infinity;
      cut = Math.round(mid);
      for (let c = lo; c <= hi; c++) {
        const ya = c - a.position + region.top;
        const yb = c - b.position + region.top;
        const disagree = rowDistance(a.sig, ya, b.sig, yb);
        const busy = ya > 0 ? rowDistance(a.sig, ya, a.sig, ya - 1) : 0;
        const cost = disagree + 0.3 * busy + 0.002 * Math.abs(c - mid);
        if (cost < best) {
          best = cost;
          cut = c;
        }
      }
    }
    if (cut >= bEnd) continue;
    cuts.push(cut);
    kept.push(b);
  }

  const pageBottom = kept[kept.length - 1].position + R;
  const gapRows = gaps.reduce((s, g) => s + g.missing, 0);
  const header = bands.header;
  const footer = bands.footer;
  const outHeight = header + (pageBottom - pageTop) - gapRows + footer;

  // Map page rows to output rows, closing up any gaps.
  const toOut = (pageY: number) => {
    let shift = 0;
    for (const g of gaps) if (pageY >= g.at + g.missing) shift += g.missing;
    return header + (pageY - pageTop) - shift;
  };

  const segments: Segment[] = kept.map((f, i) => {
    const start = i === 0 ? pageTop : Math.max(cuts[i - 1], f.position);
    const end = i === kept.length - 1 ? f.position + R : cuts[i];
    return {
      time: f.time,
      srcY: region.top + (start - f.position),
      dstY: toOut(start),
      rows: Math.max(0, end - start),
    };
  });

  const seams: Seam[] = cuts.map((c, i) => {
    const above = kept[i];
    const below = kept[i + 1];
    // The join's confidence belongs to whichever frame was placed later.
    const later = below.time >= above.time ? below : above;
    return { y: toOut(Math.max(c, below.position)), confidence: later.confidence, above: above.time, below: below.time };
  });

  const earliest = frames.reduce((a, b) => (b.time < a.time ? b : a));
  return {
    width: frameWidth,
    height: outHeight,
    frameHeight,
    header: { time: earliest.time, srcY: 0, dstY: 0, rows: header },
    footer: { time: earliest.time, srcY: frameHeight - footer, dstY: outHeight - footer, rows: footer },
    segments: segments.filter((s) => s.rows > 0),
    seams: seams.filter((s) => !gaps.some((g) => g.below.time === s.below)),
    gaps: gaps.map((g) => ({ y: toOut(g.at), missing: g.missing, above: g.above.time, below: g.below.time })),
    dropped: frames.length - kept.length,
  };
}
