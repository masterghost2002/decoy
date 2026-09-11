export const TRAFFIC_OUTCOMES = ['mocked', 'passthrough', 'failed'] as const;
export type TrafficOutcome = (typeof TRAFFIC_OUTCOMES)[number];

export const TRAFFIC_TRANSPORTS = ['fetch', 'xhr'] as const;
export type TrafficTransport = (typeof TRAFFIC_TRANSPORTS)[number];

export interface HeaderPair {
  name: string;
  value: string;
}

/**
 * Payloads are capped before they ever leave the page. A multi-megabyte upload
 * echoed into the service worker's memory for every request would be a leak,
 * and nobody reads past the first screen of it anyway.
 */
export const MAX_CAPTURED_BODY = 64 * 1024;

export function capBody(body: string | null): { body: string | null; truncated: boolean } {
  if (body === null) return { body: null, truncated: false };
  if (body.length <= MAX_CAPTURED_BODY) return { body, truncated: false };
  return { body: body.slice(0, MAX_CAPTURED_BODY), truncated: true };
}

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
  /* -- detail, for the drawer. Captured in the page, capped before sending. -- */
  requestHeaders: HeaderPair[];
  /** The serialized payload, or null for a body-less request. */
  requestBody: string | null;
  requestBodyTruncated: boolean;
  responseHeaders: HeaderPair[];
  /**
   * The response body, as text. Arrives after the entry itself for a
   * passthrough request: the body is read from a clone of the real response,
   * which cannot be awaited without adding latency to the page's own `fetch`.
   * `null` means "not captured" -- either still in flight, not textual, or
   * opaque.
   */
  responseBody: string | null;
  responseBodyTruncated: boolean;
}

/**
 * Fills in a body that arrived after its entry. Returns the same array when the
 * entry is already gone -- it may have been pushed past the cap, or the log may
 * have been cleared while the body was being read.
 */
export function applyResponseBody(
  log: readonly TrafficEntry[],
  id: string,
  body: string | null,
  truncated: boolean,
): TrafficEntry[] | null {
  const index = log.findIndex((entry) => entry.id === id);
  if (index === -1) return null;

  const next = [...log];
  const entry = next[index];
  if (entry === undefined) return null;
  next[index] = { ...entry, responseBody: body, responseBodyTruncated: truncated };
  return next;
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
