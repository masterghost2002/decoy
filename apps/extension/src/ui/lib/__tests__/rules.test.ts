import { createRule, type MockRule, type DecoyConfig, type TrafficEntry } from '@decoy/core';
import { parseRule } from '@decoy/core/schema';
import { describe, expect, it } from 'vitest';

import {
  countEnabledRules,
  duplicateRule,
  moveRule,
  moveRuleToIndex,
  moveRuleToTop,
  removeRule,
  ruleFromTrafficEntry,
  setMasterEnabled,
  setRuleEnabled,
  upsertRule,
} from '../rules';

function rule(id: string, name = id): MockRule {
  return { ...createRule(0, name), id };
}

function config(rules: MockRule[]): DecoyConfig {
  return { version: 1, enabled: true, rules };
}

const ids = (next: DecoyConfig) => next.rules.map((item) => item.id);

describe('upsertRule', () => {
  it('appends a rule that is not in the list', () => {
    const next = upsertRule(config([rule('a')]), rule('b'), 5);
    expect(ids(next)).toEqual(['a', 'b']);
  });

  it('replaces in place, so saving never reorders the list', () => {
    const next = upsertRule(config([rule('a'), rule('b'), rule('c')]), rule('b', 'renamed'), 5);
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(next.rules[1]?.name).toBe('renamed');
  });

  it('stamps updatedAt', () => {
    const next = upsertRule(config([]), rule('a'), 1234);
    expect(next.rules[0]?.updatedAt).toBe(1234);
  });

  it('does not mutate the config it was given', () => {
    const original = config([rule('a')]);
    upsertRule(original, rule('b'), 5);
    expect(ids(original)).toEqual(['a']);
  });
});

describe('moveRule', () => {
  it('moves a rule up and down', () => {
    const start = config([rule('a'), rule('b'), rule('c')]);
    expect(ids(moveRule(start, 'c', -1))).toEqual(['a', 'c', 'b']);
    expect(ids(moveRule(start, 'a', 1))).toEqual(['b', 'a', 'c']);
  });

  it('refuses to move past either end', () => {
    const start = config([rule('a'), rule('b')]);
    expect(ids(moveRule(start, 'a', -1))).toEqual(['a', 'b']);
    expect(ids(moveRule(start, 'b', 1))).toEqual(['a', 'b']);
  });

  it('ignores an unknown id', () => {
    const start = config([rule('a')]);
    expect(moveRule(start, 'nope', 1)).toBe(start);
  });
});

describe('moveRuleToIndex', () => {
  it('moves a rule to an absolute position', () => {
    const start = config([rule('a'), rule('b'), rule('c'), rule('d')]);
    expect(ids(moveRuleToIndex(start, 'd', 1))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(moveRuleToIndex(start, 'a', 2))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('is a no-op when the rule is already there', () => {
    const start = config([rule('a'), rule('b')]);
    expect(ids(moveRuleToIndex(start, 'b', 1))).toEqual(['a', 'b']);
  });

  it('clamps an out-of-range target rather than dropping the rule', () => {
    const start = config([rule('a'), rule('b'), rule('c')]);
    expect(ids(moveRuleToIndex(start, 'a', 99))).toEqual(['b', 'c', 'a']);
    expect(ids(moveRuleToIndex(start, 'c', -5))).toEqual(['c', 'a', 'b']);
  });

  it('ignores an unknown rule id', () => {
    const start = config([rule('a'), rule('b')]);
    expect(ids(moveRuleToIndex(start, 'nope', 0))).toEqual(['a', 'b']);
  });

  it('agrees with moveRuleToTop', () => {
    const start = config([rule('a'), rule('b'), rule('c')]);
    expect(ids(moveRuleToIndex(start, 'c', 0))).toEqual(ids(moveRuleToTop(start, 'c')));
  });

  it('does not mutate the config it was given', () => {
    const original = config([rule('a'), rule('b')]);
    moveRuleToIndex(original, 'b', 0);
    expect(ids(original)).toEqual(['a', 'b']);
  });
});

describe('removeRule and toggles', () => {
  it('removes only the named rule', () => {
    expect(ids(removeRule(config([rule('a'), rule('b')]), 'a'))).toEqual(['b']);
  });

  it('toggles one rule without touching the others', () => {
    const next = setRuleEnabled(config([rule('a'), rule('b')]), 'a', false, 9);
    expect(next.rules[0]?.enabled).toBe(false);
    expect(next.rules[1]?.enabled).toBe(true);
  });

  it('toggles the master switch without touching rules', () => {
    const next = setMasterEnabled(config([rule('a')]), false);
    expect(next.enabled).toBe(false);
    expect(next.rules[0]?.enabled).toBe(true);
  });

  it('counts only enabled rules', () => {
    const next = setRuleEnabled(config([rule('a'), rule('b')]), 'b', false, 0);
    expect(countEnabledRules(next)).toBe(1);
  });
});

describe('duplicateRule', () => {
  it('inserts the copy directly below the original', () => {
    const result = duplicateRule(config([rule('a'), rule('b')]), 'a', 7);
    expect(result.config.rules).toHaveLength(3);
    expect(result.config.rules[1]?.id).toBe(result.newRuleId);
    expect(result.config.rules[2]?.id).toBe('b');
  });

  it('gives the copy a new id and leaves it disabled', () => {
    const result = duplicateRule(config([rule('a', 'Original')]), 'a', 7);
    const copy = result.config.rules[1];
    expect(copy?.id).not.toBe('a');
    expect(copy?.name).toBe('Original (copy)');
    expect(copy?.enabled).toBe(false);
  });

  it('reports nothing to select for an unknown id', () => {
    const start = config([rule('a')]);
    const result = duplicateRule(start, 'nope', 7);
    expect(result.newRuleId).toBeNull();
    expect(result.config).toBe(start);
  });
});

describe('ruleFromTrafficEntry', () => {
  function entry(overrides: Partial<TrafficEntry> = {}): TrafficEntry {
    return {
      id: 'req_1',
      url: 'https://api.example.com/v1/users?page=2',
      method: 'POST',
      transport: 'fetch',
      startedAt: 0,
      durationMs: 12,
      outcome: 'passthrough',
      status: 201,
      ruleId: null,
      ruleName: null,
      tabId: 3,
      pageUrl: null,
      requestHeaders: [],
      requestBody: null,
      requestBodyTruncated: false,
      responseHeaders: [],
      responseBody: null,
      responseBodyTruncated: false,
      ...overrides,
    };
  }

  it('copies the response body the request actually returned', () => {
    const rule = ruleFromTrafficEntry(entry({ responseBody: '{"id":7,"name":"Ada"}' }), 0);
    expect(rule.action).toMatchObject({
      kind: 'respond',
      // Pretty-printed, because it is about to be edited by hand.
      body: { type: 'json', value: '{\n  "id": 7,\n  "name": "Ada"\n}' },
    });
  });

  it('keeps a body that is not JSON as text, exactly as sent', () => {
    const rule = ruleFromTrafficEntry(entry({ responseBody: 'not json at all' }), 0);
    expect(rule.action).toMatchObject({ body: { type: 'text', value: 'not json at all' } });
  });

  it('falls back to an empty object when no body was captured', () => {
    const rule = ruleFromTrafficEntry(entry({ responseBody: null }), 0);
    expect(rule.action).toMatchObject({ body: { type: 'json', value: '{}' } });
  });

  it('copies the response headers worth copying', () => {
    const rule = ruleFromTrafficEntry(
      entry({
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
      }),
      0,
    );
    expect(rule.action.kind === 'respond' && rule.action.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cache-Control', value: 'no-store' },
      { name: 'Access-Control-Allow-Origin', value: '*' },
    ]);
  });

  it('drops headers that describe the transfer rather than the response', () => {
    const rule = ruleFromTrafficEntry(
      entry({
        responseHeaders: [
          { name: 'content-length', value: '512' },
          { name: 'Date', value: 'Thu, 11 Sep 2026 09:00:00 GMT' },
          { name: 'set-cookie', value: 'session=abc' },
          { name: 'content-encoding', value: 'gzip' },
          { name: 'ETag', value: '"v1"' },
        ],
      }),
      0,
    );
    expect(rule.action.kind === 'respond' && rule.action.headers).toEqual([
      { name: 'ETag', value: '"v1"' },
    ]);
  });

  it('keeps the first of a repeated header and ignores blank names', () => {
    const rule = ruleFromTrafficEntry(
      entry({
        responseHeaders: [
          { name: 'Vary', value: 'Accept' },
          { name: 'vary', value: 'Accept' },
          { name: '  ', value: 'ignored' },
        ],
      }),
      0,
    );
    expect(rule.action.kind === 'respond' && rule.action.headers).toEqual([
      { name: 'Vary', value: 'Accept' },
    ]);
  });

  it('keeps the host and drops the query string', () => {
    // Host, because taking over the same path on every origin the page talks
    // to is not what clicking one row means. No query, because that is the
    // part that varies between calls.
    const created = ruleFromTrafficEntry(entry(), 1);
    expect(created.matcher.url).toEqual({
      mode: 'contains',
      value: 'api.example.com/v1/users',
      caseSensitive: false,
    });
  });

  it('starts with no conditions', () => {
    const created = ruleFromTrafficEntry(entry(), 1);
    expect(created.matcher.conditions).toEqual([]);
    expect(created.matcher.conditionMode).toBe('all');
  });

  it('keeps the observed method and status', () => {
    const created = ruleFromTrafficEntry(entry(), 1);
    expect(created.matcher.methods).toEqual(['POST']);
    expect(created.action).toMatchObject({ kind: 'respond', status: 201 });
  });

  it('falls back to 200 when the request never got a status', () => {
    const created = ruleFromTrafficEntry(entry({ status: null }), 1);
    expect(created.action).toMatchObject({ status: 200 });
  });

  it('uses the raw url when it will not parse', () => {
    const created = ruleFromTrafficEntry(entry({ url: 'not a url' }), 1);
    expect(created.matcher.url.value).toBe('not a url');
  });

  // Everything below is about one failure: the worker validates every write and
  // drops what it cannot parse, so a rule seeded with a method or status no
  // matcher can hold was created, sent, discarded, and never appeared -- the
  // button looked broken.
  it('normalizes a lowercase method', () => {
    const created = ruleFromTrafficEntry(entry({ method: 'get' }), 1);
    expect(created.matcher.methods).toEqual(['GET']);
  });

  it('falls back to any method for one the matcher does not know', () => {
    const created = ruleFromTrafficEntry(entry({ method: 'PROPFIND' }), 1);
    expect(created.matcher.methods).toEqual(['*']);
  });

  it('falls back to 200 for a status no response can be built from', () => {
    // A cross-origin request that failed logs 0, and the Fetch spec refuses to
    // construct a Response below 200.
    for (const status of [0, 100, 600]) {
      const created = ruleFromTrafficEntry(entry({ status }), 1);
      expect(created.action).toMatchObject({ status: 200 });
    }
  });

  it('produces a rule the worker will accept', () => {
    // The guard that matters: whatever the page did, what comes out of here
    // has to survive the same validation every write goes through.
    const hostile = entry({ method: 'query', status: 0, url: 'not a url' });
    expect(parseRule(ruleFromTrafficEntry(hostile, 1))).not.toBeNull();
  });
});
