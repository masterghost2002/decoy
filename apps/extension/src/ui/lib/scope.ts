import type { TrafficEntry } from '@decoy/core';

/**
 * What just happened on the page in front of you.
 *
 * The header used to report configuration -- `ON · 6 ACTIVE` -- which is not
 * evidence: a user who has done everything right and a user whose extension is
 * silently broken see an identical screen. This is the same data the traffic
 * log already carries, reduced to the four numbers that answer "is it working
 * *here*".
 */
export interface PageScope {
  /** The page's host, or null when nothing has been seen from it yet. */
  host: string | null;
  requests: number;
  mocked: number;
  /** Distinct rules that answered something, not a count of answers. */
  rulesFired: number;
}

export const EMPTY_PAGE_SCOPE: PageScope = {
  host: null,
  requests: 0,
  mocked: 0,
  rulesFired: 0,
};

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function summarizeScope(entries: readonly TrafficEntry[], tabId: number | null): PageScope {
  if (tabId === null) return EMPTY_PAGE_SCOPE;

  let host: string | null = null;
  let requests = 0;
  let mocked = 0;
  const rules = new Set<string>();

  for (const entry of entries) {
    if (entry.tabId !== tabId) continue;
    requests += 1;
    // Newest first, so the first entry seen is the most recent navigation --
    // which is the page the numbers are about.
    host ??= hostOf(entry.pageUrl) ?? hostOf(entry.url);
    if (entry.outcome === 'mocked') mocked += 1;
    if (entry.ruleId !== null) rules.add(entry.ruleId);
  }

  return { host, requests, mocked, rulesFired: rules.size };
}
