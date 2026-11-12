/**
 * A FrameSource hides how frames are read. The pipeline only ever asks for
 * (1) a cheap skim of tiny thumbnails and (2) full-resolution grayscale
 * frames at specific times. Two implementations:
 *
 * - SeekSource: <video> element + seeking. Works everywhere.
 * - WebCodecsSource: mp4box.js + VideoDecoder. Frame-exact, and on iPhone
 *   reads full-res pixels ~10× faster (Milestone 1: 12 ms vs 131 ms).
 */
import type { GrayFrame } from '../engine/gray';
import type { Thumb } from '../lib/thumb';

export interface SourceStats {
  skimMs: number;
  grabMs: number;
  grabs: number;
  /** Frames decoded but not used (WebCodecs only). */
  decodedExtra: number;
}

export interface FrameSource {
  readonly kind: 'seek' | 'webcodecs';
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly stats: SourceStats;
  /** Thumbnails at roughly `fps` per second across the whole video. */
  skim(fps: number, onProgress?: (fraction: number) => void): Promise<Thumb[]>;
  /**
   * Full-res grayscale frames nearest to each requested time, returned in
   * the same order. `frame.time` is the frame's true timestamp.
   */
  grab(times: number[]): Promise<GrayFrame[]>;
  dispose(): void;
}

export const newStats = (): SourceStats => ({ skimMs: 0, grabMs: 0, grabs: 0, decodedExtra: 0 });
