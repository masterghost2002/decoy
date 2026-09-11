import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PAGE_BRIDGE_CHANNEL } from '@decoy/core';
import { describe, expect, it } from 'vitest';

/**
 * The playground is served as plain files with no build step, so it cannot
 * import from `@decoy/core` and keeps its own copy of the two strings it
 * shares with the extension. A copy that drifts fails in the most confusing way
 * available -- the harness silently stops seeing any config, and every case
 * reports "not seeded" against a perfectly good rule set.
 *
 * Read as text rather than imported, because these files are outside the
 * project's own rootDir.
 */
function playgroundSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../../playground/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('the playground copies of shared constants', () => {
  it('uses the same bridge channel the content script posts on', () => {
    expect(playgroundSource('bridge-channel.js')).toContain(`'${PAGE_BRIDGE_CHANNEL}'`);
  });

  it('uses the same storage key the service worker reads', () => {
    const background = readFileSync(
      fileURLToPath(new URL('../../../background/index.ts', import.meta.url)),
      'utf8',
    );
    const key = /const STORAGE_KEY = '([^']+)'/.exec(background)?.[1];
    expect(key).toBeTypeOf('string');
    expect(playgroundSource('rules.mjs')).toContain(`export const STORAGE_KEY = '${String(key)}'`);
  });
});
