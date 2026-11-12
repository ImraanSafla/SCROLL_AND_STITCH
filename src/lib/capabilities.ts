/** Feature detection for everything the pipeline might rely on. */

export interface Capabilities {
  userAgent: string;
  standalone: boolean;
  screen: string;
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  requestVideoFrameCallback: boolean;
  offscreenCanvas: boolean;
  offscreenCanvasInWorker: boolean | null;
  createImageBitmap: boolean;
  webCodecs: boolean;
  hevcDecoder: boolean | null;
  avcDecoder: boolean | null;
  compressionStream: boolean;
  webShare: boolean;
  webShareFiles: boolean;
  serviceWorker: boolean;
}

/** Spin up a tiny worker and check it can draw with OffscreenCanvas. */
function probeWorkerOffscreen(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const src = `
        try {
          const c = new OffscreenCanvas(8, 8);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 8, 8);
          const ok = ctx.getImageData(0, 0, 1, 1).data[1] === 255;
          postMessage(ok && typeof c.convertToBlob === 'function');
        } catch (e) { postMessage(false); }`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      const done = (v: boolean) => {
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(v);
      };
      w.onmessage = (e) => done(e.data === true);
      w.onerror = () => done(false);
      setTimeout(() => done(false), 3000);
    } catch {
      resolve(false);
    }
  });
}

async function decoderSupported(codec: string): Promise<boolean | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  try {
    const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1179, codedHeight: 2556 });
    return !!r.supported;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  let webShareFiles = false;
  try {
    const f = new File([new Uint8Array(8)], 'test.png', { type: 'image/png' });
    webShareFiles = !!navigator.canShare?.({ files: [f] });
  } catch {
    webShareFiles = false;
  }
  return {
    userAgent: navigator.userAgent,
    standalone:
      matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    screen: `${screen.width}×${screen.height} pt`,
    devicePixelRatio: devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    offscreenCanvasInWorker: typeof Worker !== 'undefined' ? await probeWorkerOffscreen() : null,
    createImageBitmap: typeof createImageBitmap === 'function',
    webCodecs: typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined',
    // Typical iPhone screen recording codecs: HEVC Main and H.264 High.
    hevcDecoder: await decoderSupported('hvc1.1.6.L153.B0'),
    avcDecoder: await decoderSupported('avc1.640033'),
    compressionStream: typeof CompressionStream !== 'undefined',
    webShare: typeof navigator.share === 'function',
    webShareFiles,
    serviceWorker: 'serviceWorker' in navigator,
  };
}
