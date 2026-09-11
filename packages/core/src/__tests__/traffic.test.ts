import { describe, expect, it } from 'vitest';

import { appendTraffic, type TrafficEntry } from '../traffic.js';

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
  };
}

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
