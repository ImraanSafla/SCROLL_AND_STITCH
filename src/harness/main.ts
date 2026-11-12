/**
 * Milestone 2 test harness: runs the analysis pipeline on synthetic videos
 * with known scroll offsets (or on a real recording) and reports offsets,
 * confidence, accuracy and per-stage timing. Compares the pause-aware
 * pipeline with naive fixed-rate sampling.
 */
import '../styles/base.css';
import '../lab/lab.css';
import './harness.css';
import { analyse, planFrom, type Analysis, type Mode } from '../pipeline/analyse';
import { render, type Format } from '../pipeline/render';
import { SeekSource } from '../video/seek-source';
import type { FrameSource } from '../video/source';
import { WebCodecsSource } from '../video/webcodecs-source';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const videoSel = $<HTMLSelectElement>('videoSel');
const ownRow = $<HTMLDivElement>('ownRow');
const fileInput = $<HTMLInputElement>('file');
const fileName = $<HTMLSpanElement>('fileName');
const readerSel = $<HTMLSelectElement>('readerSel');
const modeSel = $<HTMLSelectElement>('modeSel');
const formatSel = $<HTMLSelectElement>('formatSel');
const keepStatus = $<HTMLInputElement>('keepStatus');
const video = $<HTMLVideoElement>('video');
const runBtn = $<HTMLButtonElement>('run');
const statusEl = $<HTMLParagraphElement>('status');
const runsEl = $<HTMLDivElement>('runs');
const copyBtn = $<HTMLButtonElement>('copyReport');
const copyStatus = $<HTMLSpanElement>('copyStatus');

interface Truth {
  fps: number;
  headerHeight: number;
  footerHeight: number;
  junkLead?: number;
  junkTail?: number;
  durationSec: number;
  pill?: number[];
  frames: { t: number; offset: number; junk?: number }[];
  /** URL of the perfect stitched image. */
  image: string;
}

const report: { harness: string; when: string; userAgent: string; runs: unknown[] } = {
  harness: 'milestone-3b',
  when: new Date().toISOString(),
  userAgent: navigator.userAgent,
  runs: [],
};

let ownFile: File | null = null;

videoSel.addEventListener('change', () => {
  ownRow.hidden = videoSel.value !== 'own';
});
fileInput.addEventListener('change', () => {
  ownFile = fileInput.files?.[0] ?? null;
  fileName.textContent = ownFile ? ownFile.name : '';
  fileInput.value = '';
});

async function loadInput(): Promise<{ file: File; truth: Truth | null; label: string }> {
  if (videoSel.value === 'own') {
    if (!ownFile) throw new Error('Choose a recording first.');
    return { file: ownFile, truth: null, label: ownFile.name };
  }
  const base = `${import.meta.env.BASE_URL}samples/${videoSel.value}`;
  const [v, j] = await Promise.all([fetch(`${base}.mp4`), fetch(`${base}.json`)]);
  if (!v.ok || !j.ok) throw new Error('Could not download the test video.');
  const file = new File([await v.blob()], `${videoSel.value}.mp4`, { type: 'video/mp4' });
  const truth = (await j.json()) as Truth;
  truth.image = `${base}.png`;
  return { file, truth, label: videoSel.options[videoSel.selectedIndex].text };
}

async function makeSource(file: File): Promise<{ source: FrameSource; note?: string }> {
  const want = readerSel.value;
  if (want !== 'seek' && WebCodecsSource.supported()) {
    try {
      return { source: await WebCodecsSource.create(file) };
    } catch (e) {
      if (want === 'webcodecs') throw e;
      const source = await SeekSource.create(video, file);
      return { source, note: `WebCodecs unavailable (${(e as Error).message}), used seeking.` };
    }
  }
  if (want === 'webcodecs') throw new Error('WebCodecs is not supported in this browser.');
  return { source: await SeekSource.create(video, file) };
}

const truthAt = (truth: Truth, t: number) => {
  const i = Math.min(truth.frames.length - 1, Math.max(0, Math.round(t * truth.fps)));
  return truth.frames[i].offset;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function kv(data: Record<string, string | number>) {
  const dl = el('dl', 'kv');
  for (const [k, v] of Object.entries(data)) dl.append(el('dt', undefined, k), el('dd', undefined, String(v)));
  return dl;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawTimeline(canvas: HTMLCanvasElement, a: Analysis) {
  const dpr = devicePixelRatio || 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d')!;
  const x = (t: number) => (t / Math.max(0.001, a.duration)) * w;
  const max = Math.max(4, ...a.skim.timeline.map((m) => m.motion));
  const y = (m: number) => h - 6 * dpr - (m / max) * (h - 18 * dpr);
  ctx.fillStyle = cssVar('--accent-soft');
  for (const p of a.pauses) ctx.fillRect(x(p.start), 0, Math.max(2, x(p.end) - x(p.start)), h);
  ctx.strokeStyle = cssVar('--text-2');
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(0, y(a.skim.threshold));
  ctx.lineTo(w, y(a.skim.threshold));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = cssVar('--text');
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  a.skim.timeline.forEach((m, i) => (i ? ctx.lineTo(x(m.time), y(m.motion)) : ctx.moveTo(x(m.time), y(m.motion))));
  ctx.stroke();
  for (const f of a.frames) {
    ctx.fillStyle = f.kind === 'anchor' ? cssVar('--accent') : f.kind === 'gap' ? cssVar('--warn') : cssVar('--text-2');
    ctx.fillRect(x(f.time) - dpr, 0, 2.5 * dpr, 10 * dpr);
  }
}

function renderRun(label: string, a: Analysis, truth: Truth | null, sourceNote: string | undefined, src: FrameSource): HTMLElement {
  const card = el('section', 'card');
  const title = el('h2', 'run-title');
  title.append(
    el('span', undefined, `${a.mode === 'naive' ? 'Naive' : 'Pause-aware'} · ${a.source === 'webcodecs' ? 'WebCodecs' : 'Seeking'}`),
    el('span', 'time', `${(a.timings.total / 1000).toFixed(2)} s`),
  );
  card.append(title);

  const rows = a.pairs.map((p) => {
    const t = truth ? truthAt(truth, p.to) - truthAt(truth, p.from) : null;
    return { ...p, truth: t, err: t === null ? null : p.offset - t };
  });
  const wrong = rows.filter((r) => r.err !== null && Math.abs(r.err) > 1);
  const endPos = a.frames[a.frames.length - 1]?.position ?? 0;
  const endTruth = truth && a.frames.length ? truthAt(truth, a.frames[a.frames.length - 1].time) - truthAt(truth, a.frames[0].time) : null;
  // ±5 px: HEVC re-encodes the block row straddling a bar's edge when the
  // content below moves, so the last few rows of a bar can flicker.
  const bandOk = truth ? Math.abs(a.bands.header - truth.headerHeight) <= 5 && Math.abs(a.bands.footer - truth.footerHeight) <= 5 : null;
  const weak = a.pairs.filter((p) => p.confidence < 0.35).length;

  let verdict: HTMLElement;
  if (truth) {
    const good = wrong.length === 0 && bandOk && endTruth !== null && Math.abs(endPos - endTruth) <= 2;
    verdict = el('span', `verdict ${good ? 'good' : 'bad'}`, good ? 'All joins exact' : `${wrong.length} wrong join(s)${bandOk ? '' : ', bars off by more than 5 px'}`);
  } else {
    verdict = el('span', 'verdict info', `${a.pairs.length} joins, ${weak} uncertain`);
  }
  card.append(verdict);

  const t = a.timings;
  const stageInfo: Record<string, string | number> = {
    video: label,
    'frames read in full': a.grabs,
    'thumbnails (skim)': a.skim.count,
    'skim time': `${t.skim} ms`,
    ...(t.grabAnchors !== undefined ? { 'anchor frames time': `${t.grabAnchors} ms` } : {}),
    ...(t.grab !== undefined ? { 'frame read time': `${t.grab} ms` } : {}),
    'matching time': `${t.match} ms${t.gapGrabs ? ` (incl. ${t.gapGrabs} ms reading gap frames)` : ''}`,
    'header / footer': `${a.bands.header} / ${a.bands.footer} px${truth ? ` (true: ${truth.headerHeight} / ${truth.footerHeight})` : ''}`,
    'pauses found': a.pauses.length,
    'content used': `${a.trim.start.toFixed(2)}–${a.trim.end.toFixed(2)} s of ${a.trim.duration.toFixed(2)} s${
      truth?.junkLead ? ` (true: ${truth.junkLead.toFixed(2)}–${(truth.durationSec - (truth.junkTail ?? 0)).toFixed(2)})` : ''
    }`,
    'page height covered': `${endPos + (a.region.bottom - a.region.top)} px`,
  };
  if (endTruth !== null) stageInfo['end position error'] = `${endPos - endTruth} px`;
  if (src instanceof WebCodecsSource) stageInfo['gray from'] = src.grayPath;
  if (sourceNote) stageInfo.note = sourceNote;
  if (a.warnings.length) stageInfo.warnings = a.warnings.join(' ');
  card.append(kv(stageInfo));

  const canvas = el('canvas', 'timeline');
  canvas.setAttribute('aria-label', 'Motion timeline with pauses and chosen frames');
  const legend = el('div', 'legend');
  legend.innerHTML =
    `<span><i style="background:${cssVar('--accent-soft')}"></i>pause</span>` +
    `<span><i style="background:${cssVar('--accent')}"></i>anchor frame</span>` +
    `<span><i style="background:${cssVar('--warn')}"></i>gap-fill frame</span>` +
    `<span><i style="background:${cssVar('--text')}"></i>motion</span>`;
  card.append(canvas, legend);

  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const head = el('tr');
  for (const h of ['from s', 'to s', 'offset', ...(truth ? ['true', 'error'] : []), 'conf', 'type']) head.append(el('th', undefined, h));
  table.append(head);
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', undefined, r.from.toFixed(3)), el('td', undefined, r.to.toFixed(3)), el('td', undefined, String(r.offset)));
    if (truth) {
      tr.append(el('td', undefined, String(r.truth)));
      tr.append(el('td', r.err !== null && Math.abs(r.err) > 1 ? 'err-bad' : 'err-ok', String(r.err)));
    }
    tr.append(el('td', r.confidence < 0.35 ? 'conf-low' : undefined, r.confidence.toFixed(2)));
    tr.append(el('td', undefined, r.kind + (r.byVelocity ? ' ·v' : '')));
    table.append(tr);
  }
  wrap.append(table);
  card.append(wrap);
  runsEl.prepend(card);
  drawTimeline(canvas, a);

  report.runs.push({
    video: label,
    mode: a.mode,
    reader: a.source,
    grayPath: src instanceof WebCodecsSource ? src.grayPath : undefined,
    size: `${a.width}x${a.height}`,
    duration: +a.duration.toFixed(3),
    timings: a.timings,
    source: { ...src.stats, skimMs: Math.round(src.stats.skimMs), grabMs: Math.round(src.stats.grabMs) },
    grabs: a.grabs,
    skimCount: a.skim.count,
    pauses: a.pauses.length,
    bands: a.bands,
    coarseBands: a.coarseBands,
    truthBands: truth ? { header: truth.headerHeight, footer: truth.footerHeight } : undefined,
    wrongJoins: truth ? wrong.length : undefined,
    endError: endTruth !== null ? endPos - endTruth : undefined,
    weakJoins: weak,
    warnings: a.warnings,
    note: sourceNote,
    pairs: rows.map((r) => ({
      from: +r.from.toFixed(3),
      to: +r.to.toFixed(3),
      offset: r.offset,
      truth: r.truth ?? undefined,
      conf: +r.confidence.toFixed(2),
      kind: r.kind,
      v: r.byVelocity || undefined,
    })),
  });
  return card;
}

/**
 * Row-by-row comparison of two images, band by band to limit memory.
 * Compares brightness (luma), not colour: video codecs store colour at half
 * resolution (4:2:0), which smears saturated edges over a row or two in the
 * recording itself. That is not a stitching error; a misplaced row is.
 */
async function compareImages(made: Blob, truthUrl: string, skipTopRows: number) {
  const [a, b] = await Promise.all([createImageBitmap(made), fetch(truthUrl).then((r) => r.blob()).then(createImageBitmap)]);
  const W = Math.min(a.width, b.width);
  const H = Math.min(a.height, b.height);
  const BAND = 256;
  const ca = new OffscreenCanvas(W, BAND).getContext('2d', { willReadFrequently: true })!;
  const cb = new OffscreenCanvas(W, BAND).getContext('2d', { willReadFrequently: true })!;
  let badRows = 0;
  // A stitching error shifts everything below a seam, so it shows as a long
  // run of differing rows. Codec colour edges are 1–3 rows. Count runs.
  let run = 0;
  let errorRuns = 0;
  let worst = 0;
  let worstY = -1;
  let sum = 0;
  for (let y0 = 0; y0 < H; y0 += BAND) {
    const n = Math.min(BAND, H - y0);
    ca.clearRect(0, 0, W, BAND);
    cb.clearRect(0, 0, W, BAND);
    ca.drawImage(a, 0, y0, W, n, 0, 0, W, n);
    cb.drawImage(b, 0, y0, W, n, 0, 0, W, n);
    const da = ca.getImageData(0, 0, W, n).data;
    const db = cb.getImageData(0, 0, W, n).data;
    for (let r = 0; r < n; r++) {
      if (y0 + r < skipTopRows) continue;
      let s = 0;
      let c = 0;
      for (let x = 0; x < W; x += 2) {
        const p = (r * W + x) * 4;
        const la = da[p] * 0.299 + da[p + 1] * 0.587 + da[p + 2] * 0.114;
        const lb = db[p] * 0.299 + db[p + 1] * 0.587 + db[p + 2] * 0.114;
        s += Math.abs(la - lb);
        c++;
      }
      const d = s / c;
      sum += d;
      if (d > 8) {
        badRows++;
        run++;
        if (run === 4) errorRuns++;
      } else run = 0;
      if (d > worst) {
        worst = d;
        worstY = y0 + r;
      }
    }
  }
  const result = {
    sizeMatch: a.width === b.width && a.height === b.height,
    errorRuns,
    made: `${a.width}×${a.height}`,
    expected: `${b.width}×${b.height}`,
    badRows,
    meanDiff: sum / Math.max(1, H - skipTopRows),
    worst,
    worstY,
  };
  a.close();
  b.close();
  return result;
}

async function buildImage(card: HTMLElement, a: Analysis, src: FrameSource, truth: Truth | null, label: string) {
  const section = el('div', 'image-section');
  section.append(el('h3', undefined, 'Long screenshot'));
  card.append(section);
  const t0 = performance.now();
  const plan = planFrom(a);
  const format = formatSel.value as Format;
  const res = await render(plan, src, {
    format,
    quality: 0.9,
    hidePill: !keepStatus.checked,
    onProgress: (f) => (statusEl.textContent = `Building image ${Math.round(f * 100)}%`),
  });
  const ms = performance.now() - t0;
  const bytes = res.blobs.reduce((s, b) => s + b.size, 0);
  const info: Record<string, string | number> = {
    size: `${res.width}×${res.height} px${res.blobs.length > 1 ? ` in ${res.blobs.length} parts` : ''}`,
    file: `${(bytes / 1048576).toFixed(2)} MB ${format.toUpperCase()}`,
    'build time': `${Math.round(ms)} ms (strips ${res.timings.strips}, encode ${res.timings.encode})`,
    'total time': `${((a.timings.total + ms) / 1000).toFixed(2)} s for a ${a.duration.toFixed(1)} s video`,
    seams: `${plan.seams.length}${plan.seams.some((s) => s.confidence < 0.35) ? ` (${plan.seams.filter((s) => s.confidence < 0.35).length} uncertain)` : ''}`,
    gaps: plan.gaps.length ? plan.gaps.map((g) => `${g.missing} px missing at ${g.y}`).join(', ') : 'none',
    'recording indicator': res.pill ? `hidden (${res.pill.w}×${res.pill.h} at ${res.pill.x},${res.pill.y})` : keepStatus.checked ? 'kept' : 'none found',
  };
  let verdict: HTMLElement | null = null;
  let comparison: Awaited<ReturnType<typeof compareImages>> | null = null;
  if (truth && format === 'png') {
    statusEl.textContent = 'Comparing with the perfect result…';
    // With the indicator hidden, the clock goes too: skip the status bar.
    const skip = truth.pill?.length ? Math.round(a.height * 0.08) : 0;
    comparison = await compareImages(res.blobs[0], truth.image, skip);
    const good = comparison.sizeMatch && comparison.errorRuns === 0;
    verdict = el(
      'span',
      `verdict ${good ? 'good' : 'bad'}`,
      good ? 'Matches the perfect result' : comparison.sizeMatch ? `${comparison.errorRuns} misplaced stretch(es)` : 'Wrong height',
    );
    info['vs perfect result'] =
      `${comparison.made} vs ${comparison.expected}, mean diff ${comparison.meanDiff.toFixed(2)}, ` +
      `${comparison.badRows} codec colour-edge rows, worst ${comparison.worst.toFixed(1)} at row ${comparison.worstY}`;
  }
  if (verdict) section.append(verdict);
  section.append(kv(info));

  // Preview with seams (green: confident, orange: uncertain, red: gap).
  const preview = el('div', 'preview');
  const inner = el('div', 'preview-inner');
  const urls = res.blobs.map((b) => URL.createObjectURL(b));
  for (const u of urls) {
    const img = el('img');
    img.src = u;
    img.alt = 'Stitched screenshot';
    inner.append(img);
  }
  const line = (y: number, cls: string, text: string) => {
    const d = el('div', `seam-line ${cls}`);
    d.style.top = `${(y / res.height) * 100}%`;
    d.append(el('span', undefined, text));
    inner.append(d);
  };
  for (const s of plan.seams) line(s.y, s.confidence < 0.35 ? 'low' : '', s.confidence.toFixed(2));
  for (const g of plan.gaps) line(g.y, 'gap', `gap ${g.missing}px`);
  preview.append(inner);
  section.append(preview);

  const actions = el('div', 'image-actions');
  const ext = format === 'png' ? 'png' : 'jpg';
  const files = res.blobs.map(
    (b, i) => new File([b], `scroll-stitch-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${res.blobs.length > 1 ? `-${i + 1}` : ''}.${ext}`, { type: b.type }),
  );
  if (navigator.canShare?.({ files })) {
    const share = el('button', 'btn', 'Save to Photos');
    share.addEventListener('click', async () => {
      try {
        await navigator.share({ files });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') statusEl.textContent = `Share failed: ${(e as Error).message}`;
      }
    });
    actions.append(share);
  }
  files.forEach((f, i) => {
    const link = el('a', 'btn secondary', files.length > 1 ? `Download part ${i + 1}` : 'Download');
    link.href = urls[i];
    link.download = f.name;
    actions.append(link);
  });
  section.append(actions);

  const run = report.runs[report.runs.length - 1] as Record<string, unknown>;
  run.image = {
    width: res.width,
    height: res.height,
    parts: res.parts,
    bytes,
    format,
    buildMs: Math.round(ms),
    timings: res.timings,
    seams: plan.seams.map((s) => ({ y: s.y, conf: +s.confidence.toFixed(2) })),
    gaps: plan.gaps,
    dropped: plan.dropped,
    pill: res.pill,
    comparison,
  };
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  let failedDiagnostics: Record<string, unknown> | null = null;
  runBtn.setAttribute('aria-busy', 'true');
  try {
    statusEl.textContent = 'Loading video…';
    const { file, truth, label } = await loadInput();
    const modes: Mode[] = modeSel.value === 'compare' ? ['pause-aware', 'naive'] : [modeSel.value as Mode];
    for (const mode of modes) {
      let { source, note } = await makeSource(file);
      const progress = (stage: string, f: number) => {
        statusEl.textContent = `${mode === 'naive' ? 'Naive' : 'Pause-aware'}: ${stage} ${Math.round(f * 100)}%`;
      };
      try {
        let a: Analysis;
        try {
          a = await analyse(source, { mode }, progress);
        } catch (e) {
          // In automatic mode, a WebCodecs failure falls back to seeking.
          if (source.kind !== 'webcodecs' || readerSel.value !== 'auto') throw e;
          failedDiagnostics = source.diagnostics();
          source.dispose();
          source = await SeekSource.create(video, file);
          note = `WebCodecs failed (${(e as Error).message}), so this run used video seeking.`;
          a = await analyse(source, { mode }, progress);
        }
        const card = renderRun(label, a, truth, note, source);
        const run = report.runs[report.runs.length - 1] as Record<string, unknown>;
        run.diagnostics = source.diagnostics();
        if (failedDiagnostics) run.webcodecsFailure = failedDiagnostics;
        if (mode === 'pause-aware') await buildImage(card, a, source, truth, label);
      } catch (e) {
        (e as Error & { diagnostics?: unknown }).diagnostics = source.diagnostics();
        throw e;
      } finally {
        source.dispose();
      }
    }
    statusEl.textContent = failedDiagnostics ? 'Done (used video seeking: see the note, and please send the report).' : 'Done.';
  } catch (e) {
    statusEl.textContent = `Failed: ${(e as Error).message} Tap Copy report and send it to me.`;
    report.runs.push({
      error: (e as Error).message,
      video: videoSel.value,
      reader: readerSel.value,
      diagnostics: (e as Error & { diagnostics?: unknown }).diagnostics,
      webcodecsFailure: failedDiagnostics,
    });
  } finally {
    runBtn.disabled = false;
    runBtn.removeAttribute('aria-busy');
  }
});

copyBtn.addEventListener('click', async () => {
  const text = JSON.stringify(report);
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
