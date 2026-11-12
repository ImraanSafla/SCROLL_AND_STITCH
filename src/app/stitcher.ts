/**
 * The interface's handle on stitching. Prefers the worker (WebCodecs, off
 * the main thread). Falls back to the main thread with video seeking if
 * the worker can't read the file: slower, but it works everywhere.
 */
import type { RenderResult } from '../pipeline/render';
import { Session, type ProgressFn, type RenderParams, type Summary } from '../pipeline/session';
import { SeekSource } from '../video/seek-source';
import type { WorkerRequest, WorkerResponse } from '../worker/stitch.worker';

export interface Stitcher {
  readonly reader: 'webcodecs' | 'seek';
  analyse(trim: { start: number; end: number } | undefined, onProgress: ProgressFn): Promise<Summary>;
  render(params: RenderParams, onProgress: ProgressFn): Promise<RenderResult>;
  dispose(): void;
}

/** Omit that distributes over a union of request types. */
type RequestBody = WorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: ProgressFn };

class WorkerStitcher implements Stitcher {
  readonly reader = 'webcodecs' as const;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private worker: Worker) {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m.stage as Parameters<ProgressFn>[0], m.fraction);
      else {
        this.pending.delete(m.id);
        if (m.type === 'ok') p.resolve(m.result);
        else p.reject(Object.assign(new Error(m.message), { readerFailed: m.readerFailed }));
      }
    };
    worker.onerror = (e) => {
      const err = Object.assign(new Error(e.message || 'The stitching worker stopped'), { readerFailed: true });
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  call<T>(req: RequestBody, onProgress?: ProgressFn): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  analyse(trim: { start: number; end: number } | undefined, onProgress: ProgressFn) {
    return this.call<Summary>({ type: 'analyse', trim }, onProgress);
  }

  render(params: RenderParams, onProgress: ProgressFn) {
    return this.call<RenderResult>({ type: 'render', params }, onProgress);
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Cancelled'));
    this.pending.clear();
  }
}

class MainStitcher implements Stitcher {
  readonly reader = 'seek' as const;
  constructor(private session: Session) {}
  analyse(trim: { start: number; end: number } | undefined, onProgress: ProgressFn) {
    return this.session.analyse(trim, onProgress);
  }
  render(params: RenderParams, onProgress: ProgressFn) {
    return this.session.render(params, onProgress);
  }
  dispose() {
    this.session.dispose();
  }
}

/** True when the worker path can plausibly work in this browser. */
function workerPossible() {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

/**
 * Open a video for stitching. `video` is a hidden element used only by the
 * fallback. `force` picks a reader (for debugging).
 */
export async function openStitcher(file: File, video: HTMLVideoElement, force?: 'webcodecs' | 'seek'): Promise<{ stitcher: Stitcher; note?: string }> {
  if (force !== 'seek' && workerPossible()) {
    const worker = new Worker(new URL('../worker/stitch.worker.ts', import.meta.url), { type: 'module' });
    const ws = new WorkerStitcher(worker);
    try {
      await ws.call({ type: 'start', file });
      return { stitcher: ws };
    } catch (e) {
      ws.dispose();
      if (force === 'webcodecs') throw e;
      const s = new MainStitcher(new Session(await SeekSource.create(video, file)));
      return { stitcher: s, note: `Fast reader unavailable (${(e as Error).message}); using the slower reader.` };
    }
  }
  return { stitcher: new MainStitcher(new Session(await SeekSource.create(video, file))) };
}

/**
 * Run an analysis, falling back to the main thread if the worker's reader
 * fails partway (e.g. no frames came back).
 */
export async function analyseWithFallback(
  opened: { stitcher: Stitcher; note?: string },
  file: File,
  video: HTMLVideoElement,
  trim: { start: number; end: number } | undefined,
  onProgress: ProgressFn,
): Promise<{ stitcher: Stitcher; summary: Summary; note?: string }> {
  try {
    return { stitcher: opened.stitcher, summary: await opened.stitcher.analyse(trim, onProgress), note: opened.note };
  } catch (e) {
    if (opened.stitcher.reader !== 'webcodecs' || !(e as { readerFailed?: boolean }).readerFailed) throw e;
    opened.stitcher.dispose();
    const s = new MainStitcher(new Session(await SeekSource.create(video, file)));
    return {
      stitcher: s,
      summary: await s.analyse(trim, onProgress),
      note: `Fast reader failed (${(e as Error).message}); used the slower reader.`,
    };
  }
}
