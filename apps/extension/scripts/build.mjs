/**
 * Extension builds come in two flavours and Rollup cannot emit both in one pass:
 *
 *  - the HTML surfaces (popup, tab) are a normal multi-page ES module build
 *  - the service worker, content bridge, injected script and handler sandbox
 *    must each be a single self-contained IIFE, because Chrome loads them
 *    without a module loader and the injected script has to run at
 *    document_start
 *  - the floating panel is a third kind: a whole React app, but shipped as one
 *    IIFE too, because it is injected into a page by `chrome.scripting` rather
 *    than loaded from an HTML file
 *
 * So this runs the HTML build first, then one lib build per script, all into the
 * same `dist/` with `emptyOutDir` off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');

const SCRIPT_TARGETS = [
  { name: 'background', entry: 'src/background/index.ts', globalName: 'MocksmithBackground' },
  { name: 'bridge', entry: 'src/content/bridge.ts', globalName: 'MocksmithBridge' },
  { name: 'injected', entry: 'src/injected/main.ts', globalName: 'MocksmithInjected' },
  // The handler sandbox. A classic script rather than a module, because its
  // page has an opaque origin and a module fetch from one has to satisfy CORS
  // even for the extension's own files.
  { name: 'sandbox', entry: 'src/sandbox/main.ts', globalName: 'MocksmithSandbox' },
];

async function buildHtmlSurfaces() {
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    build: { watch: watch ? {} : null },
    logLevel: 'warn',
  });
}

/**
 * The floating panel. Same single-file IIFE shape as the other scripts, but it
 * is a React app, so it needs the React and Tailwind plugins that the HTML
 * build gets from `vite.config.ts`.
 *
 * Its stylesheet is emitted beside it rather than inlined into the bundle: the
 * font `@font-face` urls in it are relative, and they only resolve to the
 * extension when the browser loads them from a `chrome-extension://` stylesheet.
 */
async function buildPanel() {
  await build({
    root,
    configFile: false,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(root, 'src') } },
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    logLevel: 'warn',
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'chrome111',
      minify: watch ? false : 'esbuild',
      sourcemap: true,
      watch: watch ? {} : null,
      lib: {
        entry: path.join(root, 'src/panel/main.tsx'),
        formats: ['iife'],
        name: 'MocksmithPanel',
        fileName: () => 'panel.js',
        cssFileName: 'panel',
      },
    },
  });

  // `cssFileName` is the supported way to name it; this is the belt to that
  // brace, because the manifest names `panel.css` and a stylesheet the panel
  // cannot find is an unstyled panel sitting on top of someone's site.
  const emitted = path.join(root, 'dist', 'style.css');
  const wanted = path.join(root, 'dist', 'panel.css');
  if (fs.existsSync(emitted) && !fs.existsSync(wanted)) {
    fs.renameSync(emitted, wanted);
  }
}

async function buildScript(target) {
  await build({
    root,
    configFile: false,
    resolve: { alias: { '@': path.join(root, 'src') } },
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    logLevel: 'warn',
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'chrome111',
      // Readable in watch mode, because when a mock misbehaves you read this
      // code in the page's own devtools. Minified for a real build, since
      // injected.js is parsed on every page load. Sourcemaps ship either way.
      minify: watch ? false : 'esbuild',
      sourcemap: true,
      watch: watch ? {} : null,
      lib: {
        entry: path.join(root, target.entry),
        formats: ['iife'],
        name: target.globalName,
        fileName: () => `${target.name}.js`,
      },
    },
  });
}

await buildHtmlSurfaces();
for (const target of SCRIPT_TARGETS) {
  await buildScript(target);
}
await buildPanel();

console.log(watch ? 'mocksmith: watching for changes' : 'mocksmith: build complete -> dist/');
