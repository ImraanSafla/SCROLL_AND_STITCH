/**
 * FrameSource backed by WebCodecs. Frames are decoded in order from the
 * nearest keyframe, so every frame is exact, with no seeking guesswork.
 *
 * Grayscale comes straight from the decoder's luma (Y) plane when the frame
 * exposes one (I420/NV12), skipping the canvas round-trip entirely; otherwise
 * it falls back to drawing the frame on a canvas.
 */
import { rgbaToGray, type GrayFrame, type GrayImage } from '../engine/gray';
import { Thumbnailer, type Thumb } from '../lib/thumb';
import { newStats, type FrameSource } from './source';
import { demux, type ContainerInfo, type EncodedSample } from './webcodecs';

interface PresEntry {
  /** Index in decode order. */
  k: number;
  /** Seconds from the first frame. */
  t: number;
  /** Chunk timestamp in µs, as handed to the decoder. */
  us: number;
}

export class WebCodecsSource implements FrameSource {
  readonly kind = 'webcodecs' as const;
  readonly stats = newStats();
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  /** Which path produced grayscale: luma plane or canvas. */
  grayPath: 'luma' | 'canvas' | 'unknown' = 'unknown';
  private pres: PresEntry[];
  private gopStart: Int32Array;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;

  private constructor(
    readonly info: ContainerInfo,
    private samples: EncodedSample[],
  ) {
    this.width = info.codedWidth;
    this.height = info.codedHeight;
    const toUs = (s: EncodedSample) => Math.round((s.cts / s.timescale) * 1e6);
    const pres = samples.map((s, k) => ({ k, us: toUs(s), t: 0 })).sort((a, b) => a.us - b.us);
    const t0 = pres.length ? pres[0].us : 0;
    for (const p of pres) p.t = (p.us - t0) / 1e6;
    this.pres = pres;
    this.duration = info.durationSec;
    this.gopStart = new Int32Array(samples.length);
    let g = 0;
    samples.forEach((s, k) => {
      if (s.isSync) g = k;
      this.gopStart[k] = g;
    });
  }

  static supported() {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  }

  static async create(file: Blob): Promise<WebCodecsSource> {
    if (!WebCodecsSource.supported()) throw new Error('WebCodecs is not available');
    const { info, samples } = await demux(file);
    if (info.rotation !== 0) {
      // VideoFrames are not rotated for us. Supported later; seek instead.
      throw new Error(`Rotated video (${info.rotation}°) not supported by the WebCodecs path yet`);
    }
    const support = await VideoDecoder.isConfigSupported({
      codec: info.codec,
      codedWidth: info.codedWidth,
      codedHeight: info.codedHeight,
      description: info.description,
    });
    if (!support.supported) throw new Error(`This browser cannot decode ${info.codec}`);
    return new WebCodecsSource(info, samples);
  }

  /** Decode each [start, end] range of decode-order indices, in order. */
  private async decodeRanges(ranges: Array<[number, number]>, handle: (frame: VideoFrame) => Promise<void> | void) {
    const pending: Promise<void>[] = [];
    let error: Error | undefined;
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const r = handle(frame);
          if (r) pending.push(r);
        } catch (e) {
          frame.close();
          error = e as Error;
        }
      },
      error: (e) => {
        error = e instanceof Error ? e : new Error(String(e));
      },
    });
    decoder.configure({
      codec: this.info.codec,
      codedWidth: this.info.codedWidth,
      codedHeight: this.info.codedHeight,
      description: this.info.description,
    });
    const waitForQueue = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          decoder.removeEventListener('dequeue', done);
          resolve();
        };
        decoder.addEventListener('dequeue', done);
        setTimeout(done, 20);
      });
    for (const [start, end] of ranges) {
      for (let k = start; k <= end && !error; k++) {
        while (decoder.decodeQueueSize > 6) await waitForQueue();
        const s = this.samples[k];
        decoder.decode(
          new EncodedVideoChunk({
            type: s.isSync ? 'key' : 'delta',
            timestamp: Math.round((s.cts / s.timescale) * 1e6),
            duration: Math.round((s.duration / s.timescale) * 1e6),
            data: s.data,
          }),
        );
      }
      if (error) break;
      await decoder.flush();
    }
    if (decoder.state !== 'closed') decoder.close();
    await Promise.all(pending);
    if (error) throw error;
  }

  async skim(fps: number, onProgress?: (f: number) => void): Promise<Thumb[]> {
    const t0 = performance.now();
    const thumb = new Thumbnailer(this.width, this.height);
    const out: Thumb[] = [];
    const step = 1 / fps;
    const firstUs = this.pres[0]?.us ?? 0;
    let next = 0;
    const total = this.samples.length;
    let seen = 0;
    await this.decodeRanges([[0, total - 1]], (frame) => {
      const t = (frame.timestamp - firstUs) / 1e6;
      seen++;
      if (t >= next - 0.5 / 60) {
        out.push(thumb.grab(frame, t));
        next += step;
        while (next <= t) next += step;
      } else {
        this.stats.decodedExtra++;
      }
      frame.close();
      if (seen % 30 === 0) onProgress?.(seen / total);
    });
    thumb.dispose();
    this.stats.skimMs += performance.now() - t0;
    return out;
  }

  private nearest(t: number): PresEntry {
    const p = this.pres;
    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(p[lo - 1].t - t) <= Math.abs(p[lo].t - t)) lo--;
    return p[lo];
  }

  private async toGray(frame: VideoFrame): Promise<GrayImage> {
    const rect = frame.visibleRect ?? new DOMRectReadOnly(0, 0, frame.codedWidth, frame.codedHeight);
    const w = rect.width;
    const h = rect.height;
    const fmt = frame.format;
    if (fmt === 'I420' || fmt === 'I420A' || fmt === 'I422' || fmt === 'I444' || fmt === 'NV12') {
      try {
        const opts = { rect: { x: rect.x, y: rect.y, width: w, height: h } };
        const buf = new Uint8Array(frame.allocationSize(opts));
        const layout = await frame.copyTo(buf, opts);
        const { offset, stride } = layout[0];
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) data.set(buf.subarray(offset + y * stride, offset + y * stride + w), y * w);
        this.grayPath = 'luma';
        return { width: w, height: h, data };
      } catch {
        /* fall through to canvas */
      }
    }
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.ctx!.drawImage(frame, 0, 0, w, h);
    this.grayPath = 'canvas';
    return rgbaToGray(this.ctx!.getImageData(0, 0, w, h).data, w, h);
  }

  async grab(times: number[]): Promise<GrayFrame[]> {
    const t0 = performance.now();
    const targets = times.map((t) => this.nearest(t));
    const wanted = new Map<number, number[]>(); // µs → result slots
    targets.forEach((p, i) => {
      const list = wanted.get(p.us) ?? [];
      list.push(i);
      wanted.set(p.us, list);
    });
    // Merge targets into decode ranges that start at their keyframe.
    const ks = [...new Set(targets.map((p) => p.k))].sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    for (const k of ks) {
      let g = this.gopStart[k];
      // HEVC open GOPs: frames that follow a keyframe in decode order but
      // are shown before it ("leading pictures") reference the previous
      // GOP, so decoding must start one keyframe earlier.
      if (g > 0 && this.samples[k].cts < this.samples[g].cts) g = this.gopStart[g - 1];
      const last = ranges[ranges.length - 1];
      if (last && g <= last[1] + 1) last[1] = Math.max(last[1], k);
      else ranges.push([g, k]);
    }
    const results: GrayFrame[] = new Array(times.length);
    const firstUs = this.pres[0]?.us ?? 0;
    await this.decodeRanges(ranges, (frame) => {
      const slots = wanted.get(frame.timestamp);
      if (!slots) {
        this.stats.decodedExtra++;
        frame.close();
        return;
      }
      wanted.delete(frame.timestamp);
      const time = (frame.timestamp - firstUs) / 1e6;
      return this.toGray(frame).then(
        (g) => {
          frame.close();
          for (const i of slots) results[i] = { ...g, time };
          this.stats.grabs++;
        },
        (e) => {
          frame.close();
          throw e;
        },
      );
    });
    const missing = results.findIndex((r) => !r);
    if (missing >= 0) throw new Error(`Decoder did not return the frame at ${times[missing].toFixed(3)} s`);
    this.stats.grabMs += performance.now() - t0;
    return results;
  }

  dispose() {
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
    this.ctx = null;
    this.samples = [];
  }
}
