/**
 * Result preview: scrollable, pinch-to-zoom (touch), ctrl/trackpad-pinch
 * zoom (desktop), double-tap to zoom, plus draggable crop handles at the top
 * and bottom. Crop values are in image pixels.
 */

export interface PreviewEls {
  preview: HTMLElement;
  inner: HTMLElement;
  img: HTMLImageElement;
  shadeTop: HTMLElement;
  shadeBottom: HTMLElement;
  handleTop: HTMLButtonElement;
  handleBottom: HTMLButtonElement;
  layer: HTMLElement;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
/** Never trim the image below this many rows. */
const MIN_REMAINING = 200;

export class Preview {
  height = 0;
  width = 0;
  cropTop = 0;
  cropBottom = 0;
  private zoom = 1;
  private url: string | null = null;
  onCrop: (top: number, bottom: number) => void = () => {};

  constructor(private els: PreviewEls) {
    this.bindZoom();
    this.bindHandle(els.handleTop, 'top');
    this.bindHandle(els.handleBottom, 'bottom');
  }

  setImage(blob: Blob, width: number, height: number) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.els.img.src = this.url;
    this.width = width;
    this.height = height;
    this.setCrop(Math.min(this.cropTop, height), Math.min(this.cropBottom, height), false);
  }

  clear() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.els.img.removeAttribute('src');
    this.cropTop = this.cropBottom = 0;
    this.setZoom(1);
  }

  setCrop(top: number, bottom: number, notify = true) {
    const H = this.height;
    top = Math.max(0, Math.round(top));
    bottom = Math.max(0, Math.round(bottom));
    if (H && top + bottom > H - MIN_REMAINING) {
      const over = top + bottom - (H - MIN_REMAINING);
      if (top >= bottom) top -= over;
      else bottom -= over;
    }
    this.cropTop = Math.max(0, top);
    this.cropBottom = Math.max(0, bottom);
    this.els.shadeTop.style.height = H ? `${(this.cropTop / H) * 100}%` : '0';
    this.els.shadeBottom.style.height = H ? `${(this.cropBottom / H) * 100}%` : '0';
    this.els.handleTop.setAttribute('aria-valuenow', String(this.cropTop));
    this.els.handleBottom.setAttribute('aria-valuenow', String(this.cropBottom));
    if (notify) this.onCrop(this.cropTop, this.cropBottom);
  }

  /** Lines across the image at the given image rows. */
  setMarkers(markers: { y: number; cls: string; label?: string }[]) {
    const layer = this.els.layer;
    layer.replaceChildren();
    for (const m of markers) {
      const d = document.createElement('div');
      d.className = `seam ${m.cls}`;
      d.style.top = `${(m.y / Math.max(1, this.height)) * 100}%`;
      if (m.label) {
        const s = document.createElement('span');
        s.textContent = m.label;
        d.append(s);
      }
      layer.append(d);
    }
    layer.hidden = markers.length === 0;
  }

  // ---------- zoom ----------

  setZoom(z: number, focalX?: number, focalY?: number) {
    const p = this.els.preview;
    const old = this.zoom;
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(z - old) < 0.001) return;
    const fx = focalX ?? p.clientWidth / 2;
    const fy = focalY ?? p.clientHeight / 2;
    const cx = (p.scrollLeft + fx) / old;
    const cy = (p.scrollTop + fy) / old;
    this.zoom = z;
    this.els.inner.style.width = `${z * 100}%`;
    p.scrollLeft = cx * z - fx;
    p.scrollTop = cy * z - fy;
  }

  zoomBy(f: number) {
    this.setZoom(this.zoom * f);
  }

  private bindZoom() {
    const p = this.els.preview;
    const local = (x: number, y: number) => {
      const r = p.getBoundingClientRect();
      return [x - r.left, y - r.top] as const;
    };
    // Touch pinch.
    let startDist = 0;
    let startZoom = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    p.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          startDist = dist(e.touches);
          startZoom = this.zoom;
        }
      },
      { passive: true },
    );
    p.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 2 || !startDist) return;
        e.preventDefault();
        const [fx, fy] = local((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
        this.setZoom((startZoom * dist(e.touches)) / startDist, fx, fy);
      },
      { passive: false },
    );
    p.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) startDist = 0;
    });
    // Safari's own gesture events would zoom the whole page; stop them here.
    p.addEventListener('gesturestart', (e) => e.preventDefault());
    // Double tap / double click toggles zoom.
    let lastTap = 0;
    p.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1 || e.touches.length) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        const t = e.changedTouches[0];
        const [fx, fy] = local(t.clientX, t.clientY);
        this.setZoom(this.zoom > 1.2 ? 1 : 2.5, fx, fy);
        lastTap = 0;
      } else lastTap = now;
    });
    p.addEventListener('dblclick', (e) => {
      const [fx, fy] = local(e.clientX, e.clientY);
      this.setZoom(this.zoom > 1.2 ? 1 : 2.5, fx, fy);
    });
    // Trackpad pinch and ctrl+wheel.
    p.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const [fx, fy] = local(e.clientX, e.clientY);
        this.setZoom(this.zoom * Math.exp(-e.deltaY / 200), fx, fy);
      },
      { passive: false },
    );
    p.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-') this.zoomBy(0.8);
      else if (e.key === '0') this.setZoom(1);
    });
  }

  // ---------- crop handles ----------

  private bindHandle(handle: HTMLButtonElement, which: 'top' | 'bottom') {
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-valuemin', '0');
    let startY = 0;
    let startVal = 0;
    let scale = 1;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      startY = e.clientY;
      startVal = which === 'top' ? this.cropTop : this.cropBottom;
      scale = this.height / Math.max(1, this.els.img.clientHeight);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const d = (e.clientY - startY) * scale;
      if (which === 'top') this.setCrop(startVal + d, this.cropBottom);
      else this.setCrop(this.cropTop, startVal - d);
    });
    const end = (e: PointerEvent) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 100 : 10;
      const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      if (which === 'top') this.setCrop(this.cropTop + dir * step, this.cropBottom);
      else this.setCrop(this.cropTop, this.cropBottom - dir * step);
    });
  }
}
