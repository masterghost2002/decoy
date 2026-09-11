import {
  PAGE_BRIDGE_CHANNEL,
  createId,
  type BridgeFromPageMessage,
  type HeaderPair,
  type TrafficEntry,
  type TrafficOutcome,
  type TrafficTransport,
} from '@decoy/core';

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
  requestHeaders?: HeaderPair[];
  requestBody?: string | null;
  requestBodyTruncated?: boolean;
  responseHeaders?: HeaderPair[];
  responseBody?: string | null;
  responseBodyTruncated?: boolean;
}

export interface Reporter {
  /** Returns the id it assigned, so a late-arriving body can be attached to it. */
  (draft: TrafficDraft): string;
  /** Fills in a response body that finished reading after the entry went out. */
  body: (id: string, body: string | null, truncated: boolean) => void;
}

/**
 * Traffic goes out over `window.postMessage`, which is the only channel between
 * the MAIN world and an isolated content script. That means the host page can
 * observe these messages -- acceptable, since the page already made every
 * request being reported.
 */
function post(message: BridgeFromPageMessage): void {
  try {
    window.postMessage(message, '*');
  } catch {
    // A page that has torn down its window is not worth a console error.
  }
}

export function createReporter(): Reporter {
  const report = ((draft: TrafficDraft) => {
    const id = createId('req');
    const entry: TrafficEntry = {
      id,
      tabId: null,
      pageUrl: null,
      requestHeaders: [],
      requestBody: null,
      requestBodyTruncated: false,
      responseHeaders: [],
      responseBody: null,
      responseBodyTruncated: false,
      ...draft,
    };
    post({
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'from-page',
      kind: 'traffic',
      entry,
    });
    return id;
  }) as Reporter;

  report.body = (id, body, truncated) => {
    if (body === null) return;
    post({
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'from-page',
      kind: 'traffic-body',
      id,
      body,
      truncated,
    });
  };

  return report;
}
