/**
 * Milestone 2 test harness: runs the analysis pipeline on synthetic videos
 * with known scroll offsets (or on a real recording) and reports offsets,
 * confidence, accuracy and per-stage timing. Compares the pause-aware
 * pipeline with naive fixed-rate sampling.
 */
import '../styles/base.css';
import '../lab/lab.css';
import './harness.css';
import { analyse, type Analysis, type Mode } from '../pipeline/analyse';
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
  frames: { t: number; offset: number }[];
}

const report: { harness: string; when: string; userAgent: string; runs: unknown[] } = {
  harness: 'milestone-2',
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
  return { file, truth: (await j.json()) as Truth, label: videoSel.options[videoSel.selectedIndex].text };
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

function renderRun(label: string, a: Analysis, truth: Truth | null, sourceNote: string | undefined, src: FrameSource) {
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
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  runBtn.setAttribute('aria-busy', 'true');
  try {
    statusEl.textContent = 'Loading video…';
    const { file, truth, label } = await loadInput();
    const modes: Mode[] = modeSel.value === 'compare' ? ['pause-aware', 'naive'] : [modeSel.value as Mode];
    for (const mode of modes) {
      const { source, note } = await makeSource(file);
      try {
        const a = await analyse(source, { mode }, (stage, f) => {
          statusEl.textContent = `${mode === 'naive' ? 'Naive' : 'Pause-aware'}: ${stage} ${Math.round(f * 100)}%`;
        });
        renderRun(label, a, truth, note, source);
      } finally {
        source.dispose();
      }
    }
    statusEl.textContent = 'Done.';
  } catch (e) {
    statusEl.textContent = `Failed: ${(e as Error).message}`;
    report.runs.push({ error: (e as Error).message, video: videoSel.value, reader: readerSel.value });
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
