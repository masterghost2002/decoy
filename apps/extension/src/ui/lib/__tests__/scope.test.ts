import type { TrafficEntry, TrafficOutcome } from '@mocksmith/core';
import { describe, expect, it } from 'vitest';

import { EMPTY_PAGE_SCOPE, summarizeScope } from '../scope';

interface EntryOptions {
  outcome?: TrafficOutcome;
  ruleId?: string | null;
  tabId?: number | null;
  pageUrl?: string | null;
  url?: string;
}

function entry(id: string, options: EntryOptions = {}): TrafficEntry {
  return {
    id,
    url: options.url ?? 'https://app.local/api/users',
    method: 'GET',
    transport: 'fetch',
    startedAt: 0,
    durationMs: 1,
    outcome: options.outcome ?? 'mocked',
    status: 200,
    ruleId: options.ruleId === undefined ? 'rule_a' : options.ruleId,
    ruleName: null,
    tabId: options.tabId === undefined ? 1 : options.tabId,
    pageUrl: options.pageUrl === undefined ? 'https://app.local/dashboard' : options.pageUrl,
    requestHeaders: [],
    requestBody: null,
    requestBodyTruncated: false,
    responseHeaders: [],
    responseBody: null,
    responseBodyTruncated: false,
  };
}

describe('summarizeScope', () => {
  it('counts only the requests from the given tab', () => {
    const scope = summarizeScope(
      [entry('a', { tabId: 1 }), entry('b', { tabId: 2 }), entry('c', { tabId: 1 })],
      1,
    );
    expect(scope.requests).toBe(2);
  });

  it('counts mocked requests apart from the total', () => {
    const scope = summarizeScope(
      [
        entry('a', { outcome: 'mocked' }),
        entry('b', { outcome: 'passthrough', ruleId: null }),
        entry('c', { outcome: 'failed', ruleId: 'rule_b' }),
      ],
      1,
    );
    expect(scope).toMatchObject({ requests: 3, mocked: 1 });
  });

  it('counts distinct rules, not the number of times they answered', () => {
    const scope = summarizeScope(
      [
        entry('a', { ruleId: 'rule_a' }),
        entry('b', { ruleId: 'rule_a' }),
        entry('c', { ruleId: 'rule_b' }),
        entry('d', { ruleId: null }),
      ],
      1,
    );
    expect(scope.rulesFired).toBe(2);
  });

  it('takes the host from the newest entry, since the log is newest first', () => {
    const scope = summarizeScope(
      [
        entry('newest', { pageUrl: 'https://now.local/page' }),
        entry('older', { pageUrl: 'https://before.local/page' }),
      ],
      1,
    );
    expect(scope.host).toBe('now.local');
  });

  it('falls back to the request host when the page url is unknown', () => {
    const scope = summarizeScope(
      [entry('a', { pageUrl: null, url: 'https://api.local/v1/users' })],
      1,
    );
    expect(scope.host).toBe('api.local');
  });

  it('leaves the host null when neither url parses', () => {
    const scope = summarizeScope([entry('a', { pageUrl: 'not a url', url: 'also not' })], 1);
    expect(scope.host).toBeNull();
    expect(scope.requests).toBe(1);
  });

  it('is empty without a tab to be scoped to', () => {
    expect(summarizeScope([entry('a')], null)).toEqual(EMPTY_PAGE_SCOPE);
  });

  it('reports zero requests for a tab that has not been seen', () => {
    const scope = summarizeScope([entry('a', { tabId: 1 })], 7);
    expect(scope).toEqual(EMPTY_PAGE_SCOPE);
  });
});
