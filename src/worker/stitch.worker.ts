/**
 * Stitching worker: runs the whole pipeline (WebCodecs decoding, analysis,
 * rendering) off the main thread, so the interface never freezes.
 * Requests are handled one at a time, in order.
 */
import { Session, type RenderParams } from '../pipeline/session';
import { WebCodecsSource } from '../video/webcodecs-source';

export type WorkerRequest =
  | { id: number; type: 'start'; file: File }
  | { id: number; type: 'analyse'; trim?: { start: number; end: number } }
  | { id: number; type: 'render'; params: RenderParams }
  | { id: number; type: 'dispose' };

export type WorkerResponse =
  | { id: number; type: 'progress'; stage: string; fraction: number }
  | { id: number; type: 'ok'; result: unknown }
  | { id: number; type: 'error'; message: string; readerFailed: boolean };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

let session: Session | null = null;
let queue: Promise<void> = Promise.resolve();

async function handle(req: WorkerRequest) {
  const progress = (stage: string, fraction: number) => post({ id: req.id, type: 'progress', stage, fraction });
  try {
    switch (req.type) {
      case 'start': {
        session?.dispose();
        session = null;
        let src: WebCodecsSource;
        try {
          src = await WebCodecsSource.create(req.file);
        } catch (e) {
          post({ id: req.id, type: 'error', message: (e as Error).message, readerFailed: true });
          return;
        }
        session = new Session(src);
        post({ id: req.id, type: 'ok', result: { reader: 'webcodecs' } });
        return;
      }
      case 'analyse': {
        if (!session) throw new Error('No video loaded');
        const summary = await session.analyse(req.trim, progress);
        post({ id: req.id, type: 'ok', result: summary });
        return;
      }
      case 'render': {
        if (!session) throw new Error('No video loaded');
        const result = await session.render(req.params, progress);
        post({ id: req.id, type: 'ok', result });
        return;
      }
      case 'dispose':
        session?.dispose();
        session = null;
        post({ id: req.id, type: 'ok', result: null });
        return;
    }
  } catch (e) {
    const err = e as Error & { readerFailed?: boolean };
    post({ id: req.id, type: 'error', message: err.message ?? String(e), readerFailed: !!err.readerFailed });
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(e.data));
};
