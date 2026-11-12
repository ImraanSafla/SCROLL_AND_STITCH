import { describe, expect, it } from 'vitest';
import { demux } from '../src/video/webcodecs';

// Unedited iPhone recordings store the index (moov) after the frame data,
// like the generated test videos. Reading in pieces smaller than the file
// used to lose every frame (0 of 917 on a real recording).
describe('demux', async () => {
  // Node's fs, loaded dynamically so the browser-only tsconfig needn't know Node types.
  const fs: { readFileSync(u: URL): Uint8Array<ArrayBuffer> } = await import('node:fs' as string);
  const blob = new Blob([fs.readFileSync(new URL('../public/samples/scroll-demo.mp4', import.meta.url))]);

  it.each([4 * 1024 * 1024, 65536, 16384])('reads every frame when the index is at the end (chunk %i)', async (chunk) => {
    const { info, samples } = await demux(blob, chunk);
    expect(info.declaredSamples).toBe(442);
    expect(samples.length).toBe(442);
    expect(samples.every((s) => s.data.length > 0)).toBe(true);
  });
});
