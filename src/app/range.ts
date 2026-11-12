/**
 * Two-thumb range slider for choosing which part of the recording to use.
 * Pointer and keyboard accessible (arrow keys: 0.1 s, shift: 1 s).
 */

const MIN_SPAN = 0.5;

export class DualRange {
  start = 0;
  end = 1;
  max = 1;
  onChange: (start: number, end: number) => void = () => {};

  constructor(
    private track: HTMLElement,
    private fill: HTMLElement,
    private thumbStart: HTMLButtonElement,
    private thumbEnd: HTMLButtonElement,
  ) {
    this.bind(thumbStart, 'start');
    this.bind(thumbEnd, 'end');
  }

  set(start: number, end: number, max: number) {
    this.max = Math.max(0.001, max);
    this.apply(start, end, false);
  }

  private apply(start: number, end: number, notify = true) {
    start = Math.max(0, Math.min(start, this.max - MIN_SPAN));
    end = Math.min(this.max, Math.max(end, start + MIN_SPAN));
    this.start = start;
    this.end = end;
    const a = (start / this.max) * 100;
    const b = (end / this.max) * 100;
    this.thumbStart.style.left = `${a}%`;
    this.thumbEnd.style.left = `${b}%`;
    this.fill.style.left = `${a}%`;
    this.fill.style.width = `${b - a}%`;
    for (const [t, v] of [
      [this.thumbStart, start],
      [this.thumbEnd, end],
    ] as const) {
      t.setAttribute('aria-valuemin', '0');
      t.setAttribute('aria-valuemax', this.max.toFixed(1));
      t.setAttribute('aria-valuenow', v.toFixed(1));
      t.setAttribute('aria-valuetext', `${v.toFixed(1)} seconds`);
    }
    if (notify) this.onChange(start, end);
  }

  private bind(thumb: HTMLButtonElement, which: 'start' | 'end') {
    const valueAt = (clientX: number) => {
      const r = this.track.getBoundingClientRect();
      return ((clientX - r.left) / Math.max(1, r.width)) * this.max;
    };
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add('dragging');
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!thumb.hasPointerCapture(e.pointerId)) return;
      const v = valueAt(e.clientX);
      if (which === 'start') this.apply(v, this.end);
      else this.apply(this.start, v);
    });
    const end = (e: PointerEvent) => {
      if (thumb.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
      thumb.classList.remove('dragging');
    };
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', end);
    thumb.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      if (which === 'start') this.apply(this.start + dir * step, this.end);
      else this.apply(this.start, this.end + dir * step);
    });
  }
}
