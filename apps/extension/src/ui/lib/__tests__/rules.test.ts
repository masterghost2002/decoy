import { createRule, type MockRule, type MocksmithConfig, type TrafficEntry } from '@mocksmith/core';
import { describe, expect, it } from 'vitest';

import {
  countEnabledRules,
  duplicateRule,
  moveRule,
  removeRule,
  ruleFromTrafficEntry,
  setMasterEnabled,
  setRuleEnabled,
  upsertRule,
} from '../rules';

function rule(id: string, name = id): MockRule {
  return { ...createRule(0, name), id };
}

function config(rules: MockRule[]): MocksmithConfig {
  return { version: 1, enabled: true, rules };
}

const ids = (next: MocksmithConfig) => next.rules.map((item) => item.id);

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
      ...overrides,
    };
  }

  it('matches on the path only, so query strings do not over-narrow it', () => {
    const created = ruleFromTrafficEntry(entry(), 1);
    expect(created.matcher.url).toEqual({
      mode: 'contains',
      value: '/v1/users',
      caseSensitive: false,
    });
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
});
