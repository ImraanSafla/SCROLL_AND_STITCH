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
  constructor(
    readonly reader: 'webcodecs' | 'seek',
    private session: Session,
  ) {}
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

/**
 * Ways of reading a video, fastest first:
 * - worker: WebCodecs in a background worker (never freezes the screen)
 * - main: WebCodecs on the page itself, in case the browser's decoder
 *   misbehaves inside workers
 * - seek: the <video> element, slow but works everywhere
 */
export type ReaderKind = 'worker' | 'main' | 'seek';
const LABEL: Record<ReaderKind, string> = { worker: 'Background reader', main: 'Fast reader', seek: 'Video reader' };

async function make(kind: ReaderKind, file: File, video: HTMLVideoElement): Promise<Stitcher> {
  if (kind === 'worker') {
    const ws = new WorkerStitcher(new Worker(new URL('../worker/stitch.worker.ts', import.meta.url), { type: 'module' }));
    try {
      await ws.call({ type: 'start', file });
    } catch (e) {
      ws.dispose();
      throw e;
    }
    return ws;
  }
  if (kind === 'main') {
    // Loaded only when needed: it brings the MP4 reader with it.
    const { WebCodecsSource } = await import('../video/webcodecs-source');
    return new MainStitcher('webcodecs', new Session(await WebCodecsSource.create(file)));
  }
  return new MainStitcher('seek', new Session(await SeekSource.create(video, file)));
}

function ladder(force?: ReaderKind): ReaderKind[] {
  if (force) return [force];
  const webcodecs = typeof VideoDecoder !== 'undefined';
  const worker = webcodecs && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  return [...(worker ? (['worker'] as const) : []), ...(webcodecs ? (['main'] as const) : []), 'seek'];
}

/**
 * Open and analyse a video, trying each reader in turn until one works.
 * `notes` records what failed on the way, for debug mode and error reports.
 */
export async function openAndAnalyse(
  file: File,
  video: HTMLVideoElement,
  trim: { start: number; end: number } | undefined,
  onProgress: ProgressFn,
  force?: ReaderKind,
): Promise<{ stitcher: Stitcher; summary: Summary; kind: ReaderKind; notes: string[] }> {
  const notes: string[] = [];
  const kinds = ladder(force);
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    let st: Stitcher | null = null;
    try {
      st = await make(kind, file, video);
      const summary = await st.analyse(trim, onProgress);
      return { stitcher: st, summary, kind, notes };
    } catch (e) {
      st?.dispose();
      notes.push(`${LABEL[kind]} failed: ${(e as Error).message}`);
      if (i === kinds.length - 1) throw Object.assign(new Error((e as Error).message), { notes });
      onProgress('reading', 0);
    }
  }
  throw new Error('No way to read this video');
}
