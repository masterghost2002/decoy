import type { MocksmithConfig } from './config.js';
import type { TrafficEntry } from './traffic.js';

/* -------------------------------------------------------------------------- */
/* Extension-internal protocol (UI and content script <-> service worker)     */
/* -------------------------------------------------------------------------- */

export type ExtensionMessage =
  | { type: 'config:get' }
  | { type: 'config:replace'; config: MocksmithConfig }
  | { type: 'traffic:list' }
  | { type: 'traffic:clear' }
  /** Batched by the content bridge; a busy page reports hundreds per second. */
  | { type: 'traffic:report'; entries: TrafficEntry[] };

export type ExtensionMessageType = ExtensionMessage['type'];

export type ExtensionResponse =
  | { ok: true; kind: 'config'; config: MocksmithConfig }
  | { ok: true; kind: 'traffic'; entries: TrafficEntry[] }
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string };

/**
 * Pushed by the service worker. Config changes go to every tab and every open
 * UI surface; traffic goes only to the UI, since no page needs it.
 */
export type ExtensionEvent =
  | { type: 'config:changed'; config: MocksmithConfig }
  | { type: 'traffic:added'; entries: TrafficEntry[] };

/* -------------------------------------------------------------------------- */
/* Page bridge protocol (MAIN world <-> isolated content script)              */
/* -------------------------------------------------------------------------- */

/**
 * Every bridge message carries this channel tag. The MAIN world shares
 * `window` with the page, so anything arriving without the tag is someone
 * else's traffic and must be ignored.
 */
export const PAGE_BRIDGE_CHANNEL = 'mocksmith.bridge.v1';

export type BridgeToPageMessage = {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'to-page';
  kind: 'config';
  config: MocksmithConfig;
};

export type BridgeFromPageMessage =
  | {
      channel: typeof PAGE_BRIDGE_CHANNEL;
      direction: 'from-page';
      kind: 'ready';
    }
  | {
      channel: typeof PAGE_BRIDGE_CHANNEL;
      direction: 'from-page';
      kind: 'traffic';
      entry: TrafficEntry;
    };

function isChannelMessage(data: unknown): data is { channel: string; direction: string; kind: string } {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    candidate['channel'] === PAGE_BRIDGE_CHANNEL &&
    typeof candidate['direction'] === 'string' &&
    typeof candidate['kind'] === 'string'
  );
}

export function isBridgeToPageMessage(data: unknown): data is BridgeToPageMessage {
  return isChannelMessage(data) && data.direction === 'to-page' && data.kind === 'config';
}

export function isBridgeFromPageMessage(data: unknown): data is BridgeFromPageMessage {
  if (!isChannelMessage(data) || data.direction !== 'from-page') return false;
  return data.kind === 'ready' || data.kind === 'traffic';
}
