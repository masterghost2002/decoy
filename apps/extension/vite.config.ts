import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds only the extension's HTML surfaces. The service worker, content bridge
 * and injected script are separate single-file IIFE builds driven by
 * `scripts/build.mjs`, because each has to load without an ES module loader.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // The script builds write into the same folder, so nothing may wipe it.
    emptyOutDir: false,
    target: 'chrome111',
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
        tab: fileURLToPath(new URL('./tab.html', import.meta.url)),
      },
    },
  },
});
