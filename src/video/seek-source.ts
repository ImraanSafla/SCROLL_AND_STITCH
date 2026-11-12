/** FrameSource backed by an HTML <video> element and seeking. */
import { rgbaToGray, type GrayFrame } from '../engine/gray';
import { Thumbnailer, type Thumb } from '../lib/thumb';
import { loadVideo, seekTo } from './element';
import { newStats, type FrameSource, type StripRequest } from './source';

export class SeekSource implements FrameSource {
  readonly kind = 'seek' as const;
  readonly stats = newStats();
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;

  private constructor(
    private video: HTMLVideoElement,
    readonly width: number,
    readonly height: number,
    readonly duration: number,
  ) {}

  static async create(video: HTMLVideoElement, file: Blob): Promise<SeekSource> {
    const v = await loadVideo(video, file);
    return new SeekSource(video, v.width, v.height, v.duration);
  }

  async skim(fps: number, onProgress?: (f: number) => void): Promise<Thumb[]> {
    const t0 = performance.now();
    const thumb = new Thumbnailer(this.width, this.height);
    const out: Thumb[] = [];
    const step = 1 / fps;
    // Stop one frame short of the end: seeking to the very end can show a
    // black frame on Safari.
    const end = Math.max(0, this.duration - 1 / 60);
    for (let t = 0; t <= end + 1e-6; t += step) {
      const r = await seekTo(this.video, Math.min(t, end));
      out.push(thumb.grab(this.video, r.mediaTime ?? r.requested));
      onProgress?.(t / end);
    }
    thumb.dispose();
    this.stats.skimMs += performance.now() - t0;
    return out;
  }

  async grab(times: number[]): Promise<GrayFrame[]> {
    const t0 = performance.now();
    if (!this.canvas) {
      this.canvas = new OffscreenCanvas(this.width, this.height);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.ctx!;
    const out: GrayFrame[] = [];
    const end = Math.max(0, this.duration - 1 / 60);
    for (const t of times) {
      const r = await seekTo(this.video, Math.min(Math.max(0, t), end));
      ctx.drawImage(this.video, 0, 0, this.width, this.height);
      const img = ctx.getImageData(0, 0, this.width, this.height);
      out.push({ ...rgbaToGray(img.data, this.width, this.height), time: r.mediaTime ?? r.requested });
      this.stats.grabs++;
    }
    this.stats.grabMs += performance.now() - t0;
    return out;
  }

  async grabStrips(requests: StripRequest[]): Promise<ImageBitmap[]> {
    if (!this.canvas) {
      this.canvas = new OffscreenCanvas(this.width, this.height);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    const out: ImageBitmap[] = new Array(requests.length);
    const times = [...new Set(requests.map((r) => r.time))].sort((a, b) => a - b);
    const end = Math.max(0, this.duration - 1 / 60);
    for (const t of times) {
      await seekTo(this.video, Math.min(Math.max(0, t), end));
      this.ctx!.drawImage(this.video, 0, 0, this.width, this.height);
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        if (r.time !== t || r.rows <= 0) continue;
        out[i] = await createImageBitmap(this.canvas, 0, r.y, this.width, r.rows);
      }
    }
    return out;
  }

  diagnostics() {
    return { reader: 'seek', duration: this.duration, size: `${this.width}x${this.height}`, ...this.stats };
  }

  dispose() {
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
    this.ctx = null;
  }
}
