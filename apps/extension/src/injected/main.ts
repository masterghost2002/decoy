/**
 * Runs in the page's own JavaScript world at document_start, before any page
 * script, and replaces `fetch` and `XMLHttpRequest` with versions that consult
 * the user's rules first.
 *
 * It has no access to chrome.* APIs. Rules arrive from the isolated content
 * script over `window.postMessage`; see `src/content/bridge.ts`.
 */
import {
  PAGE_BRIDGE_CHANNEL,
  isBridgeToPageMessage,
  type BridgeFromPageMessage,
} from '@mocksmith/core';

import { createConfigGate } from './config-gate.js';
import { installFetchPatch } from './fetch-patch.js';
import { createReporter } from './reporter.js';
import { installXhrPatch } from './xhr-patch.js';

const INSTALL_FLAG = '__mocksmithInstalled';

/**
 * How long a request made before the rules arrive is willing to wait. Long
 * enough to cover the round trip to a sleeping service worker, short enough
 * that a broken extension cannot stall a page for a noticeable time.
 */
const CONFIG_WAIT_TIMEOUT_MS = 1000;

/** Guards against a second injection, which would double-wrap the patches. */
function claimInstallation(): boolean {
  const scope = window as unknown as Record<string, unknown>;
  if (scope[INSTALL_FLAG] === true) return false;
  try {
    Object.defineProperty(window, INSTALL_FLAG, { value: true, configurable: true });
  } catch {
    scope[INSTALL_FLAG] = true;
  }
  return true;
}

function announceReady(): void {
  const message: BridgeFromPageMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'from-page',
    kind: 'ready',
  };
  try {
    window.postMessage(message, '*');
  } catch {
    // Nothing useful to do in a window that is already tearing down.
  }
}

function main(): void {
  if (!claimInstallation()) return;

  const gate = createConfigGate(CONFIG_WAIT_TIMEOUT_MS);
  const report = createReporter();

  window.addEventListener('message', (event: MessageEvent) => {
    // Only messages this window posted to itself can be from our bridge.
    if (event.source !== window) return;
    if (!isBridgeToPageMessage(event.data)) return;
    gate.update(event.data.config);
  });

  installFetchPatch({ gate, report });
  installXhrPatch({ gate, report });

  // The two content scripts race at document_start, so say hello in case the
  // bridge was ready before this listener existed.
  announceReady();
}

main();
