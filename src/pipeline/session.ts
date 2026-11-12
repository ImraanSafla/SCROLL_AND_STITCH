/**
 * A stitching session for one video: analyse once, then render as often as
 * the user changes options (trim, header/footer, format). Runs either in
 * the worker (WebCodecs) or on the main thread (video seeking fallback);
 * everything it returns can be posted between threads.
 */
import type { Plan } from '../engine/compose';
import type { FrameSource } from '../video/source';
import { analyse, planFrom, type Analysis } from './analyse';
import { render, layoutOf, type RenderOptions, type RenderResult } from './render';

export type Stage = 'reading' | 'analysing' | 'stitching';
export type ProgressFn = (stage: Stage, fraction: number) => void;

/** Everything the interface needs to know about an analysis. */
export interface Summary {
  reader: FrameSource['kind'];
  width: number;
  frameHeight: number;
  duration: number;
  /** Full output height with header and footer. */
  height: number;
  header: number;
  footer: number;
  trim: Analysis['trim'];
  pauses: number;
  seams: { y: number; confidence: number }[];
  gaps: { y: number; missing: number }[];
  frames: { time: number; position: number; kind: string; confidence: number }[];
  timings: Record<string, number>;
  warnings: string[];
}

export type RenderParams = Omit<RenderOptions, 'onProgress'>;

export class Session {
  private plan: Plan | null = null;

  constructor(readonly source: FrameSource) {}

  async analyse(trim: { start: number; end: number } | undefined, onProgress: ProgressFn): Promise<Summary> {
    const a = await analyse(this.source, { trim }, (stage, f) =>
      onProgress(stage === 'reading' ? 'reading' : 'analysing', stage === 'matching' ? 0.5 + f / 2 : f / (stage === 'reading' ? 1 : 2)),
    );
    this.plan = planFrom(a);
    const p = this.plan;
    return {
      reader: a.source,
      width: p.width,
      frameHeight: p.frameHeight,
      duration: a.duration,
      height: p.height,
      header: p.header.rows,
      footer: p.footer.rows,
      trim: a.trim,
      pauses: a.pauses.length,
      seams: p.seams.map((s) => ({ y: s.y, confidence: s.confidence })),
      gaps: p.gaps.map((g) => ({ y: g.y, missing: g.missing })),
      frames: a.frames.map((f) => ({ time: f.time, position: f.position, kind: f.kind, confidence: f.confidence })),
      timings: a.timings,
      warnings: a.warnings,
    };
  }

  async render(params: RenderParams, onProgress: ProgressFn): Promise<RenderResult> {
    if (!this.plan) throw new Error('Nothing to render yet');
    return render(this.plan, this.source, { ...params, onProgress: (f) => onProgress('stitching', f) });
  }

  /** Output height for given header/footer choices, before trimming. */
  heightFor(keepHeader: boolean, keepFooter: boolean): number {
    return this.plan ? layoutOf(this.plan, keepHeader, keepFooter).height : 0;
  }

  dispose() {
    this.source.dispose();
    this.plan = null;
  }
}
