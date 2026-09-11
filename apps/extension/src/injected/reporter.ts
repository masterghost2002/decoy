import {
  PAGE_BRIDGE_CHANNEL,
  createId,
  type BridgeFromPageMessage,
  type TrafficEntry,
  type TrafficOutcome,
  type TrafficTransport,
} from '@mocksmith/core';

/** What the page knows about a request. The tab and page url are added later. */
export interface TrafficDraft {
  url: string;
  method: string;
  transport: TrafficTransport;
  startedAt: number;
  durationMs: number;
  outcome: TrafficOutcome;
  status: number | null;
  ruleId: string | null;
  ruleName: string | null;
}

export type Reporter = (draft: TrafficDraft) => void;

/**
 * Traffic goes out over `window.postMessage`, which is the only channel between
 * the MAIN world and an isolated content script. That means the host page can
 * observe these messages -- acceptable, since the page already made every
 * request being reported.
 */
export function createReporter(): Reporter {
  return (draft) => {
    const entry: TrafficEntry = {
      id: createId('req'),
      tabId: null,
      pageUrl: null,
      ...draft,
    };
    const message: BridgeFromPageMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'from-page',
      kind: 'traffic',
      entry,
    };
    try {
      window.postMessage(message, '*');
    } catch {
      // A page that has torn down its window is not worth a console error.
    }
  };
}
