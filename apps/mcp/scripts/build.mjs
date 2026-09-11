/**
 * Bundles with esbuild rather than emitting with tsc, for the same reason the
 * service worker is bundled: `@decoy/core` is published as TypeScript
 * source, so anything importing it at runtime has to go through a step that can
 * read it.
 *
 * Two outputs, built separately because only one of them is a program:
 *
 *   dist/main.js    the CLI an MCP client spawns, with a shebang
 *   dist/bridge.js  the same bridge as a library, which the end-to-end run
 *                   drives directly — so the test exercises the real server
 *                   rather than a second implementation of it
 *
 * Declared dependencies stay external. Bundling them would make the artefact
 * bigger for no benefit: whatever installs this installs them too.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['ws', 'zod', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'warning',
  metafile: true,
};

const sizes = [];
for (const [entry, outfile, banner] of [
  ['src/main.ts', 'dist/main.js', '#!/usr/bin/env node'],
  ['src/bridge.ts', 'dist/bridge.js', null],
]) {
  const result = await build({
    ...shared,
    entryPoints: [`${root}${entry}`],
    outfile: `${root}${outfile}`,
    ...(banner === null ? {} : { banner: { js: banner } }),
  });
  const bytes = Object.values(result.metafile.outputs).find((out) => out.entryPoint)?.bytes ?? 0;
  sizes.push(`${outfile.split('/').pop()} ${String(Math.round(bytes / 1024))} kB`);
}

console.log(`decoy-mcp: build complete -> dist/ (${sizes.join(', ')})`);
