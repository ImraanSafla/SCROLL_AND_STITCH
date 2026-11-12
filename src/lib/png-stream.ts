/**
 * Streaming PNG encoder.
 *
 * Why this exists: iOS Safari caps every canvas at roughly 16.7 million
 * pixels (see canvas-limits.ts), which is only ~14,000 px tall at iPhone
 * width. Instead of compositing the final screenshot on one giant canvas,
 * we feed it to this encoder a band of rows at a time. Only the compressed
 * output is kept in memory, so the image can be any height.
 *
 * CompressionStream('deflate') produces a zlib (RFC 1950) stream, which is
 * exactly the format PNG's IDAT data requires. Supported in Safari 16.4+.
 *
 * Output is 8-bit RGB (colour type 2): screenshots are opaque, so dropping
 * alpha saves a quarter of the data before compression.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** Batch compressed output into IDAT chunks of about this size. */
const IDAT_TARGET = 256 * 1024;

export class PngStreamEncoder {
  readonly width: number;
  readonly height: number;
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private writer: WritableStreamDefaultWriter<BufferSource>;
  private pump: Promise<void>;
  private prevRow: Uint8Array<ArrayBuffer>;
  private rowsWritten = 0;

  constructor(width: number, height: number) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('CompressionStream is not supported in this browser');
    }
    this.width = width;
    this.height = height;
    this.prevRow = new Uint8Array(width * 3);

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: RGB
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // no interlace
    this.parts.push(PNG_SIGNATURE.slice(), pngChunk('IHDR', ihdr));

    const cs = new CompressionStream('deflate');
    this.writer = cs.writable.getWriter();
    this.pump = this.collect(cs.readable);
  }

  private async collect(readable: ReadableStream<Uint8Array>) {
    const reader = readable.getReader();
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (!pendingBytes) return;
      const data = new Uint8Array(pendingBytes);
      let o = 0;
      for (const p of pending) {
        data.set(p, o);
        o += p.length;
      }
      this.parts.push(pngChunk('IDAT', data));
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      if (pendingBytes >= IDAT_TARGET) flush();
    }
    flush();
  }

  /**
   * Append `rows` rows of RGBA pixels (e.g. ImageData.data for a band that is
   * exactly `width` wide). Rows are filtered with PNG's "Up" filter, which
   * suits screenshots well (large areas that repeat vertically).
   */
  async writeRows(rgba: Uint8ClampedArray | Uint8Array, rows: number): Promise<void> {
    if (this.rowsWritten + rows > this.height) throw new Error('Too many rows for PNG height');
    const w = this.width;
    const stride = 1 + w * 3;
    const out = new Uint8Array(rows * stride);
    let prev = this.prevRow;
    let cur = new Uint8Array(w * 3);
    for (let y = 0; y < rows; y++) {
      const src = y * w * 4;
      for (let x = 0, s = src, d = 0; x < w; x++, s += 4, d += 3) {
        cur[d] = rgba[s];
        cur[d + 1] = rgba[s + 1];
        cur[d + 2] = rgba[s + 2];
      }
      const o = y * stride;
      out[o] = 2; // filter type: Up
      for (let i = 0; i < cur.length; i++) out[o + 1 + i] = (cur[i] - prev[i]) & 0xff;
      const t = prev;
      prev = cur;
      cur = t;
    }
    this.prevRow = prev.slice();
    this.rowsWritten += rows;
    await this.writer.ready;
    void this.writer.write(out);
  }

  get rowsRemaining() {
    return this.height - this.rowsWritten;
  }

  async finish(): Promise<Blob> {
    if (this.rowsWritten !== this.height) {
      throw new Error(`PNG expects ${this.height} rows, got ${this.rowsWritten}`);
    }
    await this.writer.close();
    await this.pump;
    this.parts.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob(this.parts, { type: 'image/png' });
  }
}
