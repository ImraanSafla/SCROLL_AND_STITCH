/**
 * Milestone 1 lab: measures frame extraction on the real device so we can
 * pick the fastest reliable method for the pipeline.
 */
import '../styles/base.css';
import './lab.css';
import { detectCapabilities, type Capabilities } from '../lib/capabilities';
import { maxCanvasHeight, maxCanvasSquare } from '../lib/canvas-limits';
import { PngStreamEncoder } from '../lib/png-stream';
import { Thumbnailer, thumbDiff, type Thumb } from '../lib/thumb';
import { loadVideo, playThrough, seekTo, type LoadedVideo } from '../video/element';
import { decodeAll, demux, type ContainerInfo } from '../video/webcodecs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('file');
const sampleBtn = $<HTMLButtonElement>('sample');
const video = $<HTMLVideoElement>('video');
const videoWrap = $<HTMLDivElement>('videoWrap');
const videoInfoEl = $<HTMLDListElement>('videoInfo');
const runAllBtn = $<HTMLButtonElement>('runAll');
const benchEl = $<HTMLDivElement>('benchResults');
const limitsBtn = $<HTMLButtonElement>('runLimits');
const limitsEl = $<HTMLDListElement>('limits');
const pngHeightSel = $<HTMLSelectElement>('pngHeight');
const makePngBtn = $<HTMLButtonElement>('makePng');
const pngInfoEl = $<HTMLDListElement>('pngInfo');
const sharePngBtn = $<HTMLButtonElement>('sharePng');
const downloadPng = $<HTMLAnchorElement>('downloadPng');
const capsEl = $<HTMLDListElement>('caps');
const copyBtn = $<HTMLButtonElement>('copyReport');
const copyStatus = $<HTMLSpanElement>('copyStatus');

interface BenchResult {
  id: string;
  label: string;
  ms: number;
  frames: number;
  unique: number;
  /** Video seconds processed per wall-clock second. */
  speedX: number;
  details: Record<string, string | number | boolean>;
  error?: string;
}

const report: {
  lab: string;
  when: string;
  capabilities?: Capabilities;
  video?: Record<string, unknown>;
  container?: Omit<ContainerInfo, 'description'> | { error: string };
  bench: BenchResult[];
  canvasLimits?: Record<string, number>;
  tallPng?: Record<string, unknown>;
} = { lab: 'milestone-1', when: new Date().toISOString(), bench: [] };

let currentFile: File | null = null;
let loaded: LoadedVideo | null = null;
let busy = false;

// ---------- helpers ----------

function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function renderKV(el: HTMLElement, data: Record<string, unknown>) {
  el.replaceChildren();
  for (const [k, v] of Object.entries(data)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'boolean') {
      dd.textContent = v ? 'yes' : 'no';
      dd.className = v ? 'yes' : 'no';
    } else if (v === null || v === undefined) {
      dd.textContent = '—';
    } else {
      dd.textContent = String(v);
    }
    el.append(dt, dd);
  }
}

/** Let the UI paint. Falls back to a timer because rAF never fires in hidden pages. */
const nextPaint = () =>
  new Promise<void>((r) => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        setTimeout(r, 0);
      }
    };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  });

function setBusy(on: boolean) {
  busy = on;
  for (const b of [runAllBtn, sampleBtn, limitsBtn, makePngBtn]) b.disabled = on;
  runAllBtn.disabled = on || !loaded;
  fileInput.disabled = on;
}

function countUnique(thumbs: Thumb[], threshold = 0.3) {
  let n = thumbs.length ? 1 : 0;
  for (let i = 1; i < thumbs.length; i++) if (thumbDiff(thumbs[i], thumbs[i - 1]) > threshold) n++;
  return n;
}

function drawTimeline(canvas: HTMLCanvasElement, thumbs: Thumb[], duration: number) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const diffs = thumbs.slice(1).map((t, i) => ({ t: t.time, d: thumbDiff(t, thumbs[i]) }));
  const max = Math.max(4, ...diffs.map((p) => p.d));
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#0a6cff';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  diffs.forEach((p, i) => {
    const x = (p.t / Math.max(0.001, duration)) * w;
    const y = h - (p.d / max) * (h - 2 * dpr) - dpr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function resultCard(label: string) {
  const el = document.createElement('div');
  el.className = 'result running';
  const h3 = document.createElement('h3');
  const name = document.createElement('span');
  name.textContent = label;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = 'running…';
  h3.append(name, time);
  const note = document.createElement('p');
  note.className = 'note';
  el.append(h3, note);
  benchEl.append(el);
  return {
    done(r: BenchResult, thumbs?: Thumb[]) {
      el.classList.remove('running');
      if (r.error) {
        el.classList.add('failed');
        time.textContent = 'failed';
        note.textContent = r.error;
        return;
      }
      time.textContent = fmtMs(r.ms);
      const parts = [`${r.frames} frames`, `${r.unique} distinct`, `${r.speedX.toFixed(1)}× real time`];
      for (const [k, v] of Object.entries(r.details)) parts.push(`${k}: ${v}`);
      note.textContent = parts.join(' · ');
      if (thumbs && thumbs.length > 2 && loaded) {
        const c = document.createElement('canvas');
        c.setAttribute('aria-label', 'Motion timeline');
        el.append(c);
        drawTimeline(c, thumbs, loaded.duration);
      }
    },
  };
}

// ---------- video loading ----------

async function useFile(file: File) {
  if (busy) return;
  setBusy(true);
  try {
    currentFile = file;
    benchEl.replaceChildren();
    report.bench = [];
    loaded = await loadVideo(video, file);
    videoWrap.hidden = false;
    report.video = {
      name: file.name,
      type: file.type || '(none)',
      sizeMB: +(file.size / 1048576).toFixed(2),
      durationSec: +loaded.duration.toFixed(3),
      displayWidth: loaded.width,
      displayHeight: loaded.height,
      orientation: loaded.width > loaded.height ? 'landscape' : 'portrait',
    };
    let container: Record<string, unknown> = {};
    try {
      const { info } = await demux(file);
      const { description: _d, ...rest } = info;
      report.container = rest;
      container = {
        codec: info.codec,
        'coded size': `${info.codedWidth}×${info.codedHeight}`,
        rotation: `${info.rotation}°`,
        frames: info.frameCount,
        'avg fps': info.avgFps.toFixed(2),
        'frame ms': `${info.minFrameMs.toFixed(1)}–${info.maxFrameMs.toFixed(1)}`,
        'variable rate': info.variableFrameRate,
        keyframes: info.keyframes,
      };
    } catch (e) {
      report.container = { error: String((e as Error).message ?? e) };
      container = { container: `unreadable: ${(e as Error).message}` };
    }
    renderKV(videoInfoEl, {
      file: file.name,
      size: `${(file.size / 1048576).toFixed(1)} MB`,
      duration: `${loaded.duration.toFixed(2)} s`,
      shown: `${loaded.width}×${loaded.height} (${report.video.orientation})`,
      ...container,
    });
  } catch (e) {
    loaded = null;
    videoWrap.hidden = false;
    renderKV(videoInfoEl, { error: `Could not open this video: ${(e as Error).message}` });
  } finally {
    setBusy(false);
  }
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void useFile(f);
  fileInput.value = '';
});

sampleBtn.addEventListener('click', async () => {
  sampleBtn.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/scroll-demo.mp4`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await useFile(new File([blob], 'scroll-demo.mp4', { type: 'video/mp4' }));
  } catch (e) {
    renderKV(videoInfoEl, { error: `Could not load test video: ${(e as Error).message}` });
    videoWrap.hidden = false;
  } finally {
    sampleBtn.removeAttribute('aria-busy');
  }
});

// ---------- benchmarks ----------

async function benchSeekThumbs(fps: number): Promise<[BenchResult, Thumb[]]> {
  const dur = loaded!.duration;
  const thumb = new Thumbnailer(loaded!.width, loaded!.height);
  const thumbs: Thumb[] = [];
  let confirmed = 0;
  let errSum = 0;
  let errMax = 0;
  let errN = 0;
  const t0 = performance.now();
  for (let t = 0; t < dur; t += 1 / fps) {
    const r = await seekTo(video, t);
    if (r.confirmed) confirmed++;
    if (r.mediaTime !== undefined) {
      const err = Math.abs(r.mediaTime - t) * 1000;
      errSum += err;
      errMax = Math.max(errMax, err);
      errN++;
    }
    thumbs.push(thumb.grab(video, r.mediaTime ?? t));
  }
  const ms = performance.now() - t0;
  thumb.dispose();
  return [
    {
      id: `seek-${fps}fps`,
      label: `Seek, ${fps} frames per second`,
      ms,
      frames: thumbs.length,
      unique: countUnique(thumbs),
      speedX: dur / (ms / 1000),
      details: {
        'ms per seek': +(ms / thumbs.length).toFixed(1),
        'frame confirmed': `${confirmed}/${thumbs.length}`,
        'avg time error ms': errN ? +(errSum / errN).toFixed(1) : 'n/a',
        'max time error ms': errN ? +errMax.toFixed(1) : 'n/a',
      },
    },
    thumbs,
  ];
}

async function benchSeekFull(count: number): Promise<BenchResult> {
  const dur = loaded!.duration;
  const { width: w, height: h } = loaded!;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let seekMs = 0;
  let grabMs = 0;
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    const a = performance.now();
    await seekTo(video, (dur * (i + 0.5)) / count);
    const b = performance.now();
    const bmp = await createImageBitmap(video);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    ctx.getImageData(0, 0, w, h);
    grabMs += performance.now() - b;
    seekMs += b - a;
  }
  const ms = performance.now() - t0;
  canvas.width = canvas.height = 0;
  return {
    id: 'seek-fullres',
    label: `Seek + full-resolution pixels, ${count} frames`,
    ms,
    frames: count,
    unique: count,
    speedX: 0,
    details: {
      'ms per seek': +(seekMs / count).toFixed(1),
      'ms per full-res read': +(grabMs / count).toFixed(1),
    },
  };
}

async function benchPlayback(rate: number): Promise<[BenchResult, Thumb[]]> {
  const dur = loaded!.duration;
  const thumb = new Thumbnailer(loaded!.width, loaded!.height);
  const thumbs: Thumb[] = [];
  let lastPresented = -1;
  let skippedFrames = 0;
  let maxGap = 0;
  let prevTime = 0;
  let rateSeen = 0;
  const t0 = performance.now();
  await playThrough(video, rate, (el, f) => {
    rateSeen = el.playbackRate;
    if (lastPresented >= 0 && f.presentedFrames > lastPresented + 1) skippedFrames += f.presentedFrames - lastPresented - 1;
    lastPresented = f.presentedFrames;
    maxGap = Math.max(maxGap, f.mediaTime - prevTime);
    prevTime = f.mediaTime;
    thumbs.push(thumb.grab(el, f.mediaTime));
  });
  const ms = performance.now() - t0;
  thumb.dispose();
  return [
    {
      id: `play-${rate}x`,
      label: `Playback at ${rate}× speed`,
      ms,
      frames: thumbs.length,
      unique: countUnique(thumbs),
      speedX: dur / (ms / 1000),
      details: {
        'actual rate': +rateSeen.toFixed(2),
        'largest gap ms': +(maxGap * 1000).toFixed(0),
        'frames not seen by callback': skippedFrames,
      },
    },
    thumbs,
  ];
}

async function benchWebCodecs(): Promise<[BenchResult, Thumb[]]> {
  const t0 = performance.now();
  const { info, samples } = await demux(currentFile!);
  const t1 = performance.now();
  // VideoFrames are in coded (unrotated) orientation.
  const thumb = new Thumbnailer(info.codedWidth, info.codedHeight);
  const full = new OffscreenCanvas(info.codedWidth, info.codedHeight);
  const fctx = full.getContext('2d', { willReadFrequently: true })!;
  const thumbs: Thumb[] = [];
  let fullMs = 0;
  let fullN = 0;
  let i = 0;
  const stats = await decodeAll(info, samples, (frame, t) => {
    thumbs.push(thumb.grab(frame, t));
    if (i++ % 30 === 0) {
      const a = performance.now();
      fctx.drawImage(frame, 0, 0);
      fctx.getImageData(0, 0, info.codedWidth, info.codedHeight);
      fullMs += performance.now() - a;
      fullN++;
    }
  });
  const ms = performance.now() - t0;
  thumb.dispose();
  full.width = full.height = 0;
  return [
    {
      id: 'webcodecs',
      label: 'WebCodecs, every frame',
      ms,
      frames: stats.framesOut,
      unique: countUnique(thumbs),
      speedX: info.durationSec / (ms / 1000),
      details: {
        'container read ms': +(t1 - t0).toFixed(0),
        'decode ms': +(ms - (t1 - t0)).toFixed(0),
        'ms per full-res read': fullN ? +(fullMs / fullN).toFixed(1) : 'n/a',
        'hardware hint': stats.config.hardwareAcceleration ?? 'no-preference',
      },
    },
    thumbs,
  ];
}

async function runBench(label: string, fn: () => Promise<BenchResult | [BenchResult, Thumb[]]>) {
  const card = resultCard(label);
  await nextPaint();
  try {
    const out = await fn();
    const [r, thumbs] = Array.isArray(out) ? out : [out, undefined];
    report.bench.push(r);
    card.done(r, thumbs);
  } catch (e) {
    const r: BenchResult = {
      id: label,
      label,
      ms: 0,
      frames: 0,
      unique: 0,
      speedX: 0,
      details: {},
      error: String((e as Error)?.message ?? e),
    };
    report.bench.push(r);
    card.done(r);
  }
  await nextPaint();
}

runAllBtn.addEventListener('click', async () => {
  if (!loaded || busy) return;
  setBusy(true);
  runAllBtn.setAttribute('aria-busy', 'true');
  benchEl.replaceChildren();
  report.bench = [];
  try {
    await runBench('WebCodecs, every frame', benchWebCodecs);
    await runBench('Seek, 8 frames per second', () => benchSeekThumbs(8));
    await runBench('Seek + full-resolution pixels', () => benchSeekFull(10));
    await runBench('Playback at 2× speed', () => benchPlayback(2));
    await runBench('Playback at 4× speed', () => benchPlayback(4));
  } finally {
    runAllBtn.removeAttribute('aria-busy');
    setBusy(false);
  }
});

// ---------- canvas limits ----------

limitsBtn.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  limitsBtn.setAttribute('aria-busy', 'true');
  renderKV(limitsEl, { status: 'testing…' });
  await nextPaint();
  try {
    const w = loaded?.width && loaded.width < loaded.height ? loaded.width : 1179;
    const tallMain = maxCanvasHeight(w);
    await nextPaint();
    const tallOff = typeof OffscreenCanvas !== 'undefined' ? maxCanvasHeight(w, true) : 0;
    await nextPaint();
    const square = maxCanvasSquare();
    report.canvasLimits = {
      width: w,
      maxHeight: tallMain,
      maxHeightOffscreen: tallOff,
      maxSquare: square,
      maxAreaApprox: w * tallMain,
    };
    renderKV(limitsEl, {
      'tested width': `${w} px`,
      'tallest canvas': `${tallMain.toLocaleString()} px`,
      'tallest offscreen': tallOff ? `${tallOff.toLocaleString()} px` : 'n/a',
      'largest square': `${square.toLocaleString()} px`,
      'max area': `${((w * tallMain) / 1e6).toFixed(1)} million px`,
    });
  } finally {
    limitsBtn.removeAttribute('aria-busy');
    setBusy(false);
  }
});

// ---------- tall PNG ----------

let pngFile: File | null = null;

makePngBtn.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  makePngBtn.setAttribute('aria-busy', 'true');
  sharePngBtn.hidden = true;
  downloadPng.hidden = true;
  if (downloadPng.href) URL.revokeObjectURL(downloadPng.href);
  renderKV(pngInfoEl, { status: 'encoding…' });
  await nextPaint();
  try {
    const W = 1179;
    const H = Number(pngHeightSel.value);
    const BAND = 256;
    const band = new OffscreenCanvas(W, BAND);
    const ctx = band.getContext('2d', { willReadFrequently: true })!;
    const enc = new PngStreamEncoder(W, H);
    const t0 = performance.now();
    for (let y0 = 0; y0 < H; y0 += BAND) {
      const rows = Math.min(BAND, H - y0);
      for (let y = 0; y < rows; y += 100 - ((y0 + y) % 100)) {
        const gy = y0 + y;
        const stripe = Math.floor(gy / 100);
        ctx.fillStyle = `hsl(${(stripe * 37) % 360} 70% ${stripe % 2 ? 85 : 92}%)`;
        ctx.fillRect(0, y, W, 100 - (gy % 100));
      }
      ctx.fillStyle = '#111';
      ctx.font = '600 48px -apple-system, system-ui, sans-serif';
      for (let gy = Math.ceil(y0 / 1000) * 1000; gy < y0 + rows; gy += 1000) {
        ctx.fillRect(0, gy - y0, W, 4);
        ctx.fillText(`${gy.toLocaleString()} px`, 40, gy - y0 + 60);
      }
      await enc.writeRows(ctx.getImageData(0, 0, W, rows).data, rows);
    }
    const blob = await enc.finish();
    const ms = performance.now() - t0;
    band.width = band.height = 0;
    pngFile = new File([blob], `stitch-test-${H}px.png`, { type: 'image/png' });
    report.tallPng = { width: W, height: H, sizeMB: +(blob.size / 1048576).toFixed(2), encodeMs: Math.round(ms) };
    renderKV(pngInfoEl, {
      size: `${W}×${H.toLocaleString()} px`,
      file: `${(blob.size / 1048576).toFixed(2)} MB`,
      'encode time': fmtMs(ms),
    });
    sharePngBtn.hidden = !navigator.canShare?.({ files: [pngFile] });
    downloadPng.href = URL.createObjectURL(blob);
    downloadPng.download = pngFile.name;
    downloadPng.hidden = false;
  } catch (e) {
    renderKV(pngInfoEl, { error: String((e as Error).message ?? e) });
  } finally {
    makePngBtn.removeAttribute('aria-busy');
    setBusy(false);
  }
});

sharePngBtn.addEventListener('click', async () => {
  if (!pngFile) return;
  try {
    await navigator.share({ files: [pngFile] });
    if (report.tallPng) report.tallPng.shared = true;
  } catch (e) {
    if ((e as Error).name !== 'AbortError') renderKV(pngInfoEl, { error: (e as Error).message });
  }
});

// ---------- report ----------

copyBtn.addEventListener('click', async () => {
  const text = JSON.stringify(report, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = 'Copied. Paste it into the chat.';
  } catch {
    try {
      await navigator.share({ text });
      copyStatus.textContent = 'Shared.';
    } catch {
      copyStatus.textContent = 'Could not copy.';
    }
  }
  setTimeout(() => (copyStatus.textContent = ''), 4000);
});

// ---------- start ----------

void detectCapabilities().then((caps) => {
  report.capabilities = caps;
  const { userAgent, ...rest } = caps;
  renderKV(capsEl, { browser: userAgent, ...rest });
});
