export const TRAFFIC_OUTCOMES = ['mocked', 'passthrough', 'failed'] as const;
export type TrafficOutcome = (typeof TRAFFIC_OUTCOMES)[number];

export const TRAFFIC_TRANSPORTS = ['fetch', 'xhr'] as const;
export type TrafficTransport = (typeof TRAFFIC_TRANSPORTS)[number];

/**
 * One observed request. Passthrough requests are logged too: "my rule did not
 * fire and I cannot see why" is the most common way a mocking tool wastes
 * someone's afternoon.
 */
export interface TrafficEntry {
  id: string;
  url: string;
  method: string;
  transport: TrafficTransport;
  /** Epoch ms when the request left the page. */
  startedAt: number;
  durationMs: number;
  outcome: TrafficOutcome;
  /** Response status, or null when the request failed or is still open. */
  status: number | null;
  ruleId: string | null;
  ruleName: string | null;
  /** Filled in by the service worker, which is the only side that knows the tab. */
  tabId: number | null;
  pageUrl: string | null;
}

export const TRAFFIC_LOG_LIMIT = 500;

/**
 * Returns a new newest-first log, capped at `limit`. Callers report oldest
 * first. A fresh array rather than an in-place splice, so a UI mid-render never
 * sees a half-updated list.
 */
export function appendTraffic(
  log: readonly TrafficEntry[],
  entries: readonly TrafficEntry[],
  limit = TRAFFIC_LOG_LIMIT,
): TrafficEntry[] {
  if (entries.length === 0) return [...log];
  return [...entries].reverse().concat(log).slice(0, limit);
}
