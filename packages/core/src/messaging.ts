import type { DecoyConfig } from './config.js';
import type { RuleStats } from './stats.js';
import type { TrafficEntry } from './traffic.js';

/* -------------------------------------------------------------------------- */
/* Extension-internal protocol (UI and content script <-> service worker)     */
/* -------------------------------------------------------------------------- */

export type ExtensionMessage =
  | { type: 'config:get' }
  | { type: 'config:replace'; config: DecoyConfig }
  | { type: 'traffic:list' }
  | { type: 'traffic:clear' }
  | { type: 'stats:get' }
  | { type: 'stats:reset' }
  /** Batched by the content bridge; a busy page reports hundreds per second. */
  | { type: 'traffic:report'; entries: TrafficEntry[] }
  /** A response body that finished reading after its entry was already logged. */
  | { type: 'traffic:body'; id: string; body: string | null; truncated: boolean }
  /**
   * Inject the floating panel into a tab, or take it away again. The worker is
   * the only side with `chrome.scripting`, so the popup has to ask.
   */
  | { type: 'panel:toggle'; tabId: number }
  /**
   * Sent by a floating panel as it mounts and as it closes. UI events reach the
   * popup and the tab view for free over `runtime.sendMessage`, but a panel is a
   * content script: nothing gets to it except `tabs.sendMessage`, so the worker
   * has to know which tabs are worth sending to.
   */
  | { type: 'panel:attached' }
  | { type: 'panel:detached' }
  /** A content script cannot read `chrome.tabs`; only the worker knows this. */
  | { type: 'tab:whoami' };

export type ExtensionMessageType = ExtensionMessage['type'];

export type ExtensionResponse =
  | {
      ok: true;
      kind: 'config';
      config: DecoyConfig;
      /**
       * Rules the worker refused to store. Validation runs on every write,
       * including the UI's own, and a rule that fails it is dropped so one bad
       * entry cannot cost someone the rest of their setup. On a write that
       * number must be reported: a save that quietly returns fewer rules than
       * it was given looks exactly like a button that does nothing.
       */
      droppedRules: number;
    }
  | {
      ok: true;
      kind: 'traffic';
      entries: TrafficEntry[];
      /**
       * True when the worker has recorded traffic in this browser session but
       * the log is now empty -- MV3 shut the worker down and took it with it.
       * Without this an emptied log is indistinguishable from "no requests
       * happened", which is the kind of ambiguity that costs someone an
       * afternoon.
       */
      dropped: boolean;
    }
  | { ok: true; kind: 'stats'; stats: RuleStats }
  | { ok: true; kind: 'tab'; tabId: number | null }
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string };

/**
 * Pushed by the service worker. Config changes go to every tab and every open
 * UI surface; traffic goes only to the UI, since no page needs it.
 */
export type ExtensionEvent =
  | { type: 'config:changed'; config: DecoyConfig }
  | { type: 'traffic:added'; entries: TrafficEntry[] }
  | { type: 'traffic:body'; id: string; body: string | null; truncated: boolean }
  | { type: 'stats:changed'; stats: RuleStats };

/* -------------------------------------------------------------------------- */
/* Page bridge protocol (MAIN world <-> isolated content script)              */
/* -------------------------------------------------------------------------- */

/**
 * Every bridge message carries this channel tag. The MAIN world shares
 * `window` with the page, so anything arriving without the tag is someone
 * else's traffic and must be ignored.
 */
export const PAGE_BRIDGE_CHANNEL = 'decoy.bridge.v1';

export type BridgeToPageMessage = {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'to-page';
  kind: 'config';
  config: DecoyConfig;
  /**
   * Where the handler sandbox lives. An extension url, which only the isolated
   * world can ask for -- `chrome.runtime` does not exist in the page -- so it
   * travels with the config rather than being looked up where it is used.
   */
  sandboxUrl?: string;
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
    }
  | {
      channel: typeof PAGE_BRIDGE_CHANNEL;
      direction: 'from-page';
      kind: 'traffic-body';
      id: string;
      body: string | null;
      truncated: boolean;
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
  return data.kind === 'ready' || data.kind === 'traffic' || data.kind === 'traffic-body';
}
