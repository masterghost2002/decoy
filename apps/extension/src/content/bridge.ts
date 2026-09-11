/**
 * Isolated-world content script. It is the only piece that can talk to both the
 * page's JavaScript world (via postMessage) and the service worker (via
 * chrome.runtime), so it exists purely to relay:
 *
 *   service worker  --config-->  page world
 *   page world      --traffic->  service worker
 */
import {
  PAGE_BRIDGE_CHANNEL,
  isBridgeFromPageMessage,
  type BridgeToPageMessage,
  type ExtensionEvent,
  type ExtensionMessage,
  type ExtensionResponse,
  type MocksmithConfig,
  type TrafficEntry,
} from '@mocksmith/core';

/** Traffic is batched: a busy page can report hundreds of requests a second. */
const FLUSH_INTERVAL_MS = 250;
const MAX_PENDING_ENTRIES = 100;

let currentConfig: MocksmithConfig | null = null;
/**
 * Flips to false when the extension is reloaded or updated. The already-injected
 * page script keeps working with the last config it received, but there is
 * nothing left to report to until the page reloads.
 */
let extensionAlive = true;

const pendingTraffic: TrafficEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function markExtensionGone(): void {
  if (!extensionAlive) return;
  extensionAlive = false;
  clearTimeout(flushTimer);
  flushTimer = undefined;
  pendingTraffic.length = 0;
}

function sendToWorker(message: ExtensionMessage): Promise<ExtensionResponse | null> {
  if (!extensionAlive) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: ExtensionResponse | undefined) => {
        // Reading lastError is what suppresses the "unchecked runtime error"
        // console noise when the worker is gone.
        if (chrome.runtime.lastError !== undefined) {
          markExtensionGone();
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    } catch {
      markExtensionGone();
      resolve(null);
    }
  });
}

/** `null` once the extension has been reloaded out from under this page. */
function sandboxUrl(): string | undefined {
  try {
    return chrome.runtime.getURL('sandbox.html');
  } catch {
    return undefined;
  }
}

function postConfigToPage(config: MocksmithConfig): void {
  const message: BridgeToPageMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'to-page',
    kind: 'config',
    config,
    sandboxUrl: sandboxUrl(),
  };
  try {
    window.postMessage(message, '*');
  } catch {
    // The window may already be gone; the next page load will re-sync.
  }
}

function flushTraffic(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (pendingTraffic.length === 0) return;

  const entries = pendingTraffic.splice(0, pendingTraffic.length);
  void sendToWorker({ type: 'traffic:report', entries });
}

function queueTraffic(entry: TrafficEntry): void {
  if (!extensionAlive) return;

  pendingTraffic.push(entry);
  if (pendingTraffic.length >= MAX_PENDING_ENTRIES) {
    flushTraffic();
    return;
  }
  flushTimer ??= setTimeout(flushTraffic, FLUSH_INTERVAL_MS);
}

function handlePageMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  if (!isBridgeFromPageMessage(event.data)) return;

  if (event.data.kind === 'ready') {
    if (currentConfig !== null) postConfigToPage(currentConfig);
    return;
  }

  if (event.data.kind === 'traffic-body') {
    const { id, body, truncated } = event.data;
    // Sent straight through rather than batched: it has to arrive after the
    // entry it belongs to, and the entry may still be sitting in the batch.
    flushTraffic();
    void sendToWorker({ type: 'traffic:body', id, body, truncated });
    return;
  }

  queueTraffic(event.data.entry);
}

function handleWorkerEvent(message: unknown): void {
  const event = message as ExtensionEvent;
  if (typeof event !== 'object' || event === null) return;
  if (event.type !== 'config:changed') return;

  currentConfig = event.config;
  postConfigToPage(event.config);
}

function requestInitialConfig(): void {
  void sendToWorker({ type: 'config:get' }).then((response) => {
    if (response === null || response.ok !== true || response.kind !== 'config') return;
    currentConfig = response.config;
    // Post unconditionally: the page listener may already exist even if its
    // "ready" message has not reached us yet.
    postConfigToPage(response.config);
  });
}

window.addEventListener('message', handlePageMessage);
chrome.runtime.onMessage.addListener(handleWorkerEvent);
// Losing the last few entries on navigation would make the log look wrong.
window.addEventListener('pagehide', flushTraffic);

requestInitialConfig();
