/**
 * Scroll & Stitch app: pick a recording → stitch → adjust → save.
 * The heavy lifting runs in a worker (see stitcher.ts); this file is the
 * interface and its state.
 */
import './app.css';
import type { RenderResult } from '../pipeline/render';
import type { Stage, Summary } from '../pipeline/session';
import { loadVideo, seekTo } from '../video/element';
import { Preview } from './preview';
import { DualRange } from './range';
import { analyseWithFallback, openStitcher, type Stitcher } from './stitcher';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DEBUG = new URLSearchParams(location.search).has('debug');
const FORCE_READER = new URLSearchParams(location.search).get('reader') as 'webcodecs' | 'seek' | null;
/** Recordings longer than this get a gentle memory warning. */
const LONG_SECONDS = 20;

const els = {
  views: { empty: $('viewEmpty'), work: $('viewWork'), error: $('viewError'), result: $('viewResult') },
  dropOverlay: $('dropOverlay'),
  dropzone: $<HTMLLabelElement>('dropzone'),
  fileInput: $<HTMLInputElement>('fileInput'),
  dropError: $('dropError'),
  clipThumb: $<HTMLImageElement>('clipThumb'),
  clipName: $('clipName'),
  clipSub: $('clipSub'),
  longNote: $('longNote'),
  stageLabel: $('stageLabel'),
  bar: $('bar'),
  barFill: $('barFill'),
  steps: $('steps'),
  errorBody: $('errorBody'),
  errorRetry: $<HTMLButtonElement>('errorRetry'),
  errorNew: $<HTMLButtonElement>('errorNew'),
  resultSize: $('resultSize'),
  gapNote: $('gapNote'),
  previewBusy: $('previewBusy'),
  trimTopOut: $<HTMLOutputElement>('trimTopOut'),
  trimBottomOut: $<HTMLOutputElement>('trimBottomOut'),
  trimStatus: $<HTMLButtonElement>('trimStatus'),
  rowHeader: $('rowHeader'),
  rowFooter: $('rowFooter'),
  rowPill: $('rowPill'),
  keepHeader: $<HTMLInputElement>('keepHeader'),
  keepFooter: $<HTMLInputElement>('keepFooter'),
  hidePill: $<HTMLInputElement>('hidePill'),
  qualityRow: $('qualityRow'),
  quality: $<HTMLInputElement>('quality'),
  qualityOut: $<HTMLOutputElement>('qualityOut'),
  rangeOut: $<HTMLOutputElement>('rangeOut'),
  restitch: $<HTMLButtonElement>('restitch'),
  debugPanel: $<HTMLDetailsElement>('debugPanel'),
  debugText: $('debugText'),
  saveBar: $('saveBar'),
  saveBtn: $<HTMLButtonElement>('saveBtn'),
  saveHint: $('saveHint'),
  downloadLink: $<HTMLAnchorElement>('downloadLink'),
  newBtn: $<HTMLButtonElement>('newBtn'),
  hiddenVideo: $<HTMLVideoElement>('hiddenVideo'),
};

const preview = new Preview({
  preview: $('preview'),
  inner: $('previewInner'),
  img: $<HTMLImageElement>('previewImg'),
  shadeTop: $('shadeTop'),
  shadeBottom: $('shadeBottom'),
  handleTop: $<HTMLButtonElement>('handleTop'),
  handleBottom: $<HTMLButtonElement>('handleBottom'),
  layer: $('debugLayer'),
});
const range = new DualRange($('range'), $('rangeFill'), $<HTMLButtonElement>('rangeStart'), $<HTMLButtonElement>('rangeEnd'));

// ---------- State ----------

interface Options {
  keepHeader: boolean;
  keepFooter: boolean;
  hidePill: boolean;
  format: 'png' | 'jpeg';
  quality: number;
}

const state = {
  file: null as File | null,
  stitcher: null as Stitcher | null,
  summary: null as Summary | null,
  note: undefined as string | undefined,
  opts: { keepHeader: true, keepFooter: true, hidePill: true, format: 'png', quality: 0.9 } as Options,
  previewResult: null as RenderResult | null,
  exportResult: null as RenderResult | null,
  exportUrls: [] as string[],
  pillSeen: false,
  /** Bumped on every change; stale renders are ignored. */
  token: 0,
  exportTimer: 0 as ReturnType<typeof setTimeout> | 0,
  busy: false,
};

const canShareFiles = (() => {
  try {
    return !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
})();

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: fine */
    }
  },
};

// ---------- Views ----------

function show(view: keyof typeof els.views) {
  for (const [k, el] of Object.entries(els.views)) el.hidden = k !== view;
  els.saveBar.hidden = view !== 'result';
  els.dropzone.setAttribute('aria-disabled', String(view === 'work'));
  document.body.classList.toggle('compact', view !== 'empty');
}

const STAGE_TEXT: Record<Stage | 'done', string> = {
  reading: 'Reading video',
  analysing: 'Analysing',
  stitching: 'Stitching',
  done: 'Done',
};
const STAGE_SPAN: Record<Stage, [number, number]> = { reading: [0, 0.45], analysing: [0.45, 0.75], stitching: [0.75, 1] };

function setStage(stage: Stage | 'done', fraction = 0) {
  els.stageLabel.textContent = STAGE_TEXT[stage];
  const order = ['reading', 'analysing', 'stitching', 'done'];
  const idx = order.indexOf(stage);
  for (const li of els.steps.querySelectorAll('li')) {
    const i = order.indexOf(li.dataset.step!);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  }
  const overall = stage === 'done' ? 1 : STAGE_SPAN[stage][0] + (STAGE_SPAN[stage][1] - STAGE_SPAN[stage][0]) * fraction;
  els.barFill.style.width = `${Math.round(overall * 100)}%`;
  els.bar.setAttribute('aria-valuenow', String(Math.round(overall * 100)));
}

function showError(message: string) {
  els.errorBody.textContent = message;
  show('error');
}

const fmtTime = (s: number) => `${s.toFixed(1)} s`;

// ---------- Picking a file ----------

function isVideo(f: File) {
  return f.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(f.name);
}

function rejectFile(f: File) {
  els.dropError.textContent = `“${f.name}” isn't a video. Choose a screen recording from Photos.`;
  els.dropError.hidden = false;
  els.dropzone.classList.add('invalid');
  setTimeout(() => els.dropzone.classList.remove('invalid'), 1500);
}

async function clipInfo(file: File): Promise<{ thumb: string; duration: number }> {
  // A separate, throwaway video element just for the thumbnail and duration.
  const v = document.createElement('video');
  try {
    const info = await loadVideo(v, file);
    await seekTo(v, Math.min(info.duration * 0.4, Math.max(0, info.duration - 0.1)));
    const w = 160;
    const h = Math.round((info.height / info.width) * w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(v, 0, 0, w, h);
    return { thumb: c.toDataURL('image/jpeg', 0.8), duration: info.duration };
  } finally {
    if (v.src.startsWith('blob:')) URL.revokeObjectURL(v.src);
    v.removeAttribute('src');
    v.load();
  }
}

async function start(file: File, trim?: { start: number; end: number }) {
  if (state.busy) return;
  if (!isVideo(file)) return rejectFile(file);
  els.dropError.hidden = true;
  const sameFile = state.file === file && state.stitcher;
  if (!sameFile) teardown();
  state.file = file;
  state.busy = true;
  show('work');
  setStage('reading', 0);
  window.scrollTo({ top: 0 });

  if (!sameFile) {
    els.clipName.textContent = file.name;
    els.clipSub.textContent = `${(file.size / 1048576).toFixed(1)} MB`;
    els.clipThumb.removeAttribute('src');
    els.longNote.hidden = true;
    clipInfo(file)
      .then(({ thumb, duration }) => {
        if (state.file !== file) return;
        els.clipThumb.src = thumb;
        els.clipSub.textContent = `${fmtTime(duration)} · ${(file.size / 1048576).toFixed(1)} MB`;
        els.longNote.hidden = duration <= LONG_SECONDS;
      })
      .catch(() => {
        /* thumbnail is optional */
      });
  }

  try {
    const opened = sameFile
      ? { stitcher: state.stitcher!, note: state.note }
      : await openStitcher(file, els.hiddenVideo, FORCE_READER ?? undefined);
    const progress = (stage: Stage, f: number) => setStage(stage, f);
    const res = await analyseWithFallback(opened, file, els.hiddenVideo, trim, progress);
    state.stitcher = res.stitcher;
    state.note = res.note;
    state.summary = res.summary;
    preview.cropTop = preview.cropBottom = 0;
    await renderPreview(true);
    setStage('done');
    showResult();
  } catch (e) {
    console.error(e);
    showError(friendly(e as Error));
  } finally {
    state.busy = false;
  }
}

function friendly(e: Error): string {
  const m = e.message || String(e);
  if (/too short|No frames|Only one frame/i.test(m)) return 'This recording is too short, or its frames could not be read. Try a longer recording.';
  if (/decode|codec|support/i.test(m)) return `This browser couldn't read the video (${m}). Try recording again, or open the app in Safari.`;
  return `Something went wrong while stitching: ${m}`;
}

// ---------- Rendering ----------

async function renderPreview(first = false) {
  const st = state.stitcher;
  if (!st) return;
  const token = ++state.token;
  if (!first) els.previewBusy.hidden = false;
  setSaveBusy(true);
  try {
    const r = await st.render(
      { format: 'png', hidePill: state.opts.hidePill, keepHeader: state.opts.keepHeader, keepFooter: state.opts.keepFooter },
      (stage, f) => first && setStage(stage, f),
    );
    if (token !== state.token) return;
    if (r.pill) state.pillSeen = true;
    state.previewResult = r;
    preview.setImage(r.blobs[0], r.width, r.height);
    updateMarkers();
    updateResultText();
    scheduleExport(0);
  } finally {
    if (token === state.token) els.previewBusy.hidden = true;
  }
}

/** The file that will be saved: preview + trim + format. */
function scheduleExport(delay = 450) {
  if (state.exportTimer) clearTimeout(state.exportTimer);
  setSaveBusy(true);
  resetSaved();
  state.exportTimer = setTimeout(async () => {
    state.exportTimer = 0;
    const st = state.stitcher;
    const pr = state.previewResult;
    if (!st || !pr) return;
    const token = state.token;
    const { cropTop, cropBottom } = preview;
    let r: RenderResult;
    if (!cropTop && !cropBottom && state.opts.format === 'png') {
      r = pr;
    } else {
      r = await st.render(
        {
          format: state.opts.format,
          quality: state.opts.quality,
          hidePill: state.opts.hidePill,
          keepHeader: state.opts.keepHeader,
          keepFooter: state.opts.keepFooter,
          cropTop,
          cropBottom,
        },
        () => {},
      );
      if (token !== state.token || cropTop !== preview.cropTop || cropBottom !== preview.cropBottom) return;
    }
    setExport(r);
  }, delay);
}

function setExport(r: RenderResult) {
  for (const u of state.exportUrls) URL.revokeObjectURL(u);
  state.exportResult = r;
  state.exportUrls = r.blobs.map((b) => URL.createObjectURL(b));
  const ext = r.blobs[0].type === 'image/jpeg' ? 'jpg' : 'png';
  els.downloadLink.href = state.exportUrls[0];
  els.downloadLink.download = fileNames(ext, r.blobs.length)[0];
  els.downloadLink.textContent = r.blobs.length > 1 ? `Download ${r.blobs.length} parts` : `Download ${ext.toUpperCase()}`;
  setSaveBusy(false);
  updateResultText();
}

function setSaveBusy(busy: boolean) {
  els.saveBtn.disabled = busy;
  els.saveBtn.setAttribute('aria-busy', String(busy));
  els.saveBtn.querySelector('.label')!.textContent = busy ? 'Preparing' : canShareFiles ? 'Save to Photos' : 'Download image';
}

function resetSaved() {
  els.saveBtn.classList.remove('saved');
}

// ---------- Result view ----------

function showResult() {
  const s = state.summary!;
  show('result');
  els.rowHeader.hidden = s.header === 0;
  els.rowFooter.hidden = s.footer === 0;
  els.rowPill.hidden = !state.pillSeen;
  els.keepHeader.checked = state.opts.keepHeader;
  els.keepFooter.checked = state.opts.keepFooter;
  els.hidePill.checked = state.opts.hidePill;
  range.set(s.trim.start, s.trim.end, s.duration);
  els.restitch.hidden = true;
  updateRangeText();
  updateTrimText();
  els.downloadLink.hidden = !canShareFiles; // on desktop the main button downloads
  els.saveHint.textContent = canShareFiles
    ? store.get('sas.saved')
      ? 'Opens the share sheet.'
      : 'Tap Save Image in the share sheet.'
    : 'Saves the full-resolution image.';
  if (s.gaps.length) {
    const missing = s.gaps.reduce((a, g) => a + g.missing, 0);
    els.gapNote.textContent = `Part of the page wasn't captured (about ${missing} px, marked in red). Scrolling a little slower avoids this.`;
    els.gapNote.hidden = false;
  } else els.gapNote.hidden = true;
  els.debugPanel.hidden = !DEBUG;
  if (DEBUG) updateDebug();
}

function updateResultText() {
  const r = state.exportResult ?? state.previewResult;
  if (!r) return;
  const mb = r.blobs.reduce((a, b) => a + b.size, 0) / 1048576;
  const type = r.blobs[0].type === 'image/jpeg' ? 'JPEG' : 'PNG';
  els.resultSize.textContent = `${r.width} × ${r.height.toLocaleString()} px · ${mb.toFixed(1)} MB ${type}${r.blobs.length > 1 ? ` · ${r.blobs.length} parts` : ''}`;
}

function updateMarkers() {
  const s = state.summary;
  if (!s) return;
  // Header/footer choices shift everything below them.
  const shift = state.opts.keepHeader ? 0 : s.header;
  const markers = s.gaps.map((g) => ({ y: g.y - shift, cls: 'gap', label: `${g.missing} px missing` }));
  if (DEBUG) for (const sm of s.seams) markers.push({ y: sm.y - shift, cls: sm.confidence < 0.35 ? 'low' : '', label: sm.confidence.toFixed(2) });
  preview.setMarkers(markers);
}

function updateTrimText() {
  els.trimTopOut.value = `${preview.cropTop} px`;
  els.trimBottomOut.value = `${preview.cropBottom} px`;
  for (const [id, on] of [
    ['shadeTop', preview.cropTop > 0],
    ['shadeBottom', preview.cropBottom > 0],
  ] as const)
    $(id).classList.toggle('active', on);
  const s = state.summary;
  const statusRows = s ? Math.round(s.frameHeight * 0.065) : 0;
  const statusShown = state.opts.keepHeader || !s?.header;
  els.trimStatus.disabled = !statusShown;
  els.trimStatus.setAttribute('aria-pressed', String(preview.cropTop === statusRows && statusRows > 0));
}

function updateRangeText() {
  els.rangeOut.value = `${fmtTime(range.start)} – ${fmtTime(range.end)}`;
}

function updateDebug() {
  const s = state.summary!;
  const lines = [
    `reader: ${s.reader}${state.note ? ` (${state.note})` : ''}`,
    `frame: ${s.width}×${s.frameHeight}, header ${s.header}, footer ${s.footer}`,
    `used: ${s.trim.start.toFixed(2)}–${s.trim.end.toFixed(2)} s (detected ${s.trim.detectedStart.toFixed(2)}–${s.trim.detectedEnd.toFixed(2)}) of ${s.duration.toFixed(2)} s`,
    `pauses: ${s.pauses}, seams: ${s.seams.length}, gaps: ${s.gaps.length}`,
    `timings: ${Object.entries(s.timings).map(([k, v]) => `${k} ${v}ms`).join(', ')}`,
    ...s.warnings.map((w) => `warning: ${w}`),
    '',
    'frames (time → page position, confidence):',
    ...s.frames.map((f) => `  ${f.time.toFixed(3)} s → ${f.position} px  ${f.confidence.toFixed(2)}  ${f.kind}`),
  ];
  els.debugText.textContent = lines.join('\n');
}

// ---------- Saving ----------

function fileNames(ext: string, parts: number): string[] {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `Scroll-Stitch ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
  return Array.from({ length: parts }, (_, i) => `${base}${parts > 1 ? ` part ${i + 1}` : ''}.${ext}`);
}

async function save() {
  const r = state.exportResult;
  if (!r) return;
  const ext = r.blobs[0].type === 'image/jpeg' ? 'jpg' : 'png';
  const names = fileNames(ext, r.blobs.length);
  const files = r.blobs.map((b, i) => new File([b], names[i], { type: b.type }));
  if (canShareFiles && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      store.set('sas.saved', '1');
      els.saveBtn.classList.add('saved');
      els.saveBtn.querySelector('.label')!.textContent = 'Done';
      els.saveHint.textContent = 'If you tapped Save Image, it’s in Photos now.';
    } catch (e) {
      if ((e as Error).name !== 'AbortError') els.saveHint.textContent = `Couldn't open the share sheet (${(e as Error).message}). Use Download instead.`;
    }
    return;
  }
  downloadAll(files);
  els.saveBtn.classList.add('saved');
  els.saveBtn.querySelector('.label')!.textContent = 'Downloaded';
}

function downloadAll(files: File[]) {
  files.forEach((f, i) => {
    const a = document.createElement('a');
    a.href = state.exportUrls[i] ?? URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
  });
}

// ---------- Teardown ----------

function teardown() {
  state.token++;
  if (state.exportTimer) clearTimeout(state.exportTimer);
  state.stitcher?.dispose();
  state.stitcher = null;
  state.summary = null;
  state.note = undefined;
  state.previewResult = null;
  state.exportResult = null;
  state.pillSeen = false;
  for (const u of state.exportUrls) URL.revokeObjectURL(u);
  state.exportUrls = [];
  state.opts = { ...state.opts, keepHeader: true, keepFooter: true, hidePill: true };
  preview.clear();
}

function reset() {
  teardown();
  state.file = null;
  els.fileInput.value = '';
  show('empty');
  window.scrollTo({ top: 0 });
}

// ---------- Events ----------

els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files?.[0];
  els.fileInput.value = '';
  if (f) void start(f);
});
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || state.busy) return;
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.classList.add('show');
  els.dropzone.classList.add('dragover');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = state.busy ? 'none' : 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    els.dropOverlay.classList.remove('show');
    els.dropzone.classList.remove('dragover');
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.classList.remove('show');
  els.dropzone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer?.files ?? []);
  const video = files.find(isVideo);
  if (video) void start(video);
  else if (files[0]) {
    if (!els.views.empty.hidden) rejectFile(files[0]);
    else showError(`“${files[0].name}” isn't a video. Drop a screen recording instead.`);
  }
});

els.errorRetry.addEventListener('click', () => {
  const f = state.file;
  teardown();
  if (f) void start(f);
  else reset();
});
els.errorNew.addEventListener('click', reset);
els.newBtn.addEventListener('click', reset);

// Zoom buttons.
$('zoomIn').addEventListener('click', () => preview.zoomBy(1.5));
$('zoomOut').addEventListener('click', () => preview.zoomBy(1 / 1.5));
$('zoomReset').addEventListener('click', () => preview.setZoom(1));

// Trim.
preview.onCrop = () => {
  updateTrimText();
  scheduleExport();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-trim]')) {
  b.addEventListener('click', () => {
    const d = Number(b.dataset.delta);
    if (b.dataset.trim === 'top') preview.setCrop(preview.cropTop + d, preview.cropBottom);
    else preview.setCrop(preview.cropTop, preview.cropBottom + d);
  });
}
els.trimStatus.addEventListener('click', () => {
  const s = state.summary;
  if (!s) return;
  const rows = Math.round(s.frameHeight * 0.065);
  preview.setCrop(preview.cropTop === rows ? 0 : rows, preview.cropBottom);
});

// Switches: these change the preview itself.
for (const [input, key] of [
  [els.keepHeader, 'keepHeader'],
  [els.keepFooter, 'keepFooter'],
  [els.hidePill, 'hidePill'],
] as const) {
  input.addEventListener('change', () => {
    state.opts[key] = input.checked;
    if (key !== 'hidePill') preview.setCrop(0, 0, false);
    updateTrimText();
    void renderPreview();
  });
}

// Format and quality only change the saved file.
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="format"]')) {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    state.opts.format = r.value as Options['format'];
    els.qualityRow.hidden = state.opts.format !== 'jpeg';
    scheduleExport(0);
  });
}
els.quality.addEventListener('input', () => {
  els.qualityOut.value = `${els.quality.value}%`;
  state.opts.quality = Number(els.quality.value) / 100;
  scheduleExport();
});

// Which part of the recording to use.
range.onChange = () => {
  updateRangeText();
  const s = state.summary;
  els.restitch.hidden = !s || (Math.abs(range.start - s.trim.start) < 0.05 && Math.abs(range.end - s.trim.end) < 0.05);
};
els.restitch.addEventListener('click', () => {
  if (state.file) void start(state.file, { start: range.start, end: range.end });
});

els.saveBtn.addEventListener('click', () => void save());
els.downloadLink.addEventListener('click', (e) => {
  const r = state.exportResult;
  if (r && r.blobs.length > 1) {
    e.preventDefault();
    const ext = r.blobs[0].type === 'image/jpeg' ? 'jpg' : 'png';
    const names = fileNames(ext, r.blobs.length);
    downloadAll(r.blobs.map((b, i) => new File([b], names[i], { type: b.type })));
  }
});

show('empty');

// Debug: ?debug&sample=scroll-junk loads a bundled test video.
const sample = new URLSearchParams(location.search).get('sample');
if (DEBUG && sample && /^[a-z-]+$/.test(sample)) {
  fetch(`${import.meta.env.BASE_URL}samples/${sample}.mp4`)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((b) => start(new File([b], `${sample}.mp4`, { type: 'video/mp4' })))
    .catch((e) => showError(`Couldn't load the test video: ${(e as Error).message}`));
}
