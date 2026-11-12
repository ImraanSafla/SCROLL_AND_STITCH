import { describe, expect, it } from 'vitest';
import { demux } from '../src/video/webcodecs';

describe('demux bytes', async () => {
  const fs: { readFileSync(u: URL): Uint8Array<ArrayBuffer> } = await import('node:fs' as string);
  for (const name of ['scroll-demo', 'scroll-junk']) {
    const blob = new Blob([fs.readFileSync(new URL(`../public/samples/${name}.mp4`, import.meta.url))]);
    it.each([65536, 16384, 4096])(`${name}: frame bytes identical when read in %i-byte pieces`, async (chunk) => {
      const whole = await demux(blob, 64 * 1024 * 1024);
      const pieces = await demux(blob, chunk);
      expect(pieces.samples.length).toBe(whole.samples.length);
      let bad = 0;
      whole.samples.forEach((s, i) => {
        const p = pieces.samples[i];
        if (p.cts !== s.cts || p.isSync !== s.isSync || p.data.length !== s.data.length || p.data.some((b, j) => b !== s.data[j])) bad++;
      });
      expect(bad).toBe(0);
    });
  }
});
