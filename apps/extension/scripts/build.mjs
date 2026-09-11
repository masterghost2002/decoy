/**
 * Extension builds come in two flavours and Rollup cannot emit both in one pass:
 *
 *  - the HTML surfaces (popup, tab) are a normal multi-page ES module build
 *  - the service worker, content bridge and injected script must each be a
 *    single self-contained IIFE, because Chrome loads them without a module
 *    loader and the injected script has to run at document_start
 *
 * So this runs the HTML build first, then one lib build per script, all into the
 * same `dist/` with `emptyOutDir` off.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');

const SCRIPT_TARGETS = [
  { name: 'background', entry: 'src/background/index.ts', globalName: 'MocksmithBackground' },
  { name: 'bridge', entry: 'src/content/bridge.ts', globalName: 'MocksmithBridge' },
  { name: 'injected', entry: 'src/injected/main.ts', globalName: 'MocksmithInjected' },
];

async function buildHtmlSurfaces() {
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    build: { watch: watch ? {} : null },
    logLevel: 'warn',
  });
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

console.log(watch ? 'mocksmith: watching for changes' : 'mocksmith: build complete -> dist/');
