import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves the site from /SCROLL_AND_STITCH/, so production
// builds use that base. The dev server runs from the root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/SCROLL_AND_STITCH/' : '/',
  build: {
    target: 'safari16',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        lab: resolve(import.meta.dirname, 'lab.html'),
        harness: resolve(import.meta.dirname, 'harness.html'),
      },
    },
  },
  worker: { format: 'es' },
}));
