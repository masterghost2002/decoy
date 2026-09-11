import { describe, expect, it } from 'vitest';

import { appendTraffic, applyResponseBody, type TrafficEntry } from '../traffic.js';

function entry(id: string): TrafficEntry {
  return {
    id,
    url: `https://api.example.com/${id}`,
    method: 'GET',
    transport: 'fetch',
    startedAt: 0,
    durationMs: 1,
    outcome: 'passthrough',
    status: 200,
    ruleId: null,
    ruleName: null,
    tabId: null,
    pageUrl: null,
    requestHeaders: [],
    requestBody: null,
    requestBodyTruncated: false,
    responseHeaders: [],
    responseBody: null,
    responseBodyTruncated: false,
  };
}

describe('applyResponseBody', () => {
  it('fills in a body that arrived after its entry', () => {
    const log = [entry('a'), entry('b')];
    const next = applyResponseBody(log, 'b', '{"ok":true}', false);
    expect(next?.[1]).toMatchObject({
      id: 'b',
      responseBody: '{"ok":true}',
      responseBodyTruncated: false,
    });
  });

  it('leaves every other entry alone', () => {
    const log = [entry('a'), entry('b')];
    const next = applyResponseBody(log, 'b', 'x', false);
    expect(next?.[0]).toBe(log[0]);
  });

  it('does not mutate the log it was given', () => {
    const log = [entry('a')];
    applyResponseBody(log, 'a', 'x', false);
    expect(log[0]?.responseBody).toBeNull();
  });

  it('records truncation', () => {
    const next = applyResponseBody([entry('a')], 'a', 'partial', true);
    expect(next?.[0]?.responseBodyTruncated).toBe(true);
  });

  it('returns null when the entry has already been dropped', () => {
    // Pushed past the cap, or the log was cleared mid-read.
    expect(applyResponseBody([entry('a')], 'gone', 'x', false)).toBeNull();
    expect(applyResponseBody([], 'a', 'x', false)).toBeNull();
  });
});

const ids = (log: TrafficEntry[]) => log.map((item) => item.id);

describe('appendTraffic', () => {
  it('puts the newest entry first', () => {
    const log = appendTraffic(appendTraffic([], [entry('a')]), [entry('b')]);
    expect(ids(log)).toEqual(['b', 'a']);
  });

  it('reverses a batch so the last reported entry ends up on top', () => {
    const log = appendTraffic([], [entry('a'), entry('b'), entry('c')]);
    expect(ids(log)).toEqual(['c', 'b', 'a']);
  });

  it('caps the log and discards the oldest entries', () => {
    const log = appendTraffic([entry('old')], [entry('x'), entry('y')], 2);
    expect(ids(log)).toEqual(['y', 'x']);
  });

  it('never mutates the log it was given', () => {
    const original = appendTraffic([], [entry('a')]);
    const next = appendTraffic(original, [entry('b')]);
    expect(ids(original)).toEqual(['a']);
    expect(next).not.toBe(original);
  });

  it('returns a copy when there is nothing to add', () => {
    const original = appendTraffic([], [entry('a')]);
    const next = appendTraffic(original, []);
    expect(ids(next)).toEqual(['a']);
    expect(next).not.toBe(original);
  });
});
