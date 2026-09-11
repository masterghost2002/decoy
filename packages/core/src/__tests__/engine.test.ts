import { describe, expect, it } from 'vitest';

import type { DecoyConfig } from '../config.js';
import { CONFIG_VERSION } from '../config.js';
import { decideRequest, findMatchingRule } from '../engine.js';
import { METHOD_ANY } from '../http.js';
import type { MockRule, RuleAction } from '../rule.js';

function rule(id: string, urlValue: string, overrides: Partial<MockRule> = {}): MockRule {
  const action: RuleAction = {
    kind: 'respond',
    status: 404,
    statusText: '',
    headers: [],
    body: { type: 'json', value: '{}' },
    delayMs: 0,
  };
  return {
    id,
    name: id,
    enabled: true,
    matcher: {
      url: { mode: 'contains', value: urlValue, caseSensitive: false },
      methods: [METHOD_ANY],
      conditions: [],
      conditionMode: 'all',
    },
    action,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function config(rules: MockRule[], enabled = true): DecoyConfig {
  return { version: CONFIG_VERSION, enabled, rules };
}

const request = { url: 'https://api.example.com/v1/users', method: 'GET' };

describe('findMatchingRule', () => {
  it('returns the first matching rule in list order', () => {
    const found = findMatchingRule(config([rule('a', '/v1'), rule('b', '/v1/users')]), request);
    expect(found?.id).toBe('a');
  });

  it('skips disabled rules', () => {
    const found = findMatchingRule(
      config([rule('a', '/v1', { enabled: false }), rule('b', '/v1/users')]),
      request,
    );
    expect(found?.id).toBe('b');
  });

  it('returns null when the master switch is off', () => {
    expect(findMatchingRule(config([rule('a', '/v1')], false), request)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingRule(config([rule('a', '/orders')]), request)).toBeNull();
  });

  it('lets a passthrough rule shadow a broader mock below it', () => {
    const exception = rule('keep-real', '/v1/users/me', { action: { kind: 'passthrough' } });
    const broad = rule('mock-all', '/v1/users');
    const decision = decideRequest(config([exception, broad]), {
      url: 'https://api.example.com/v1/users/me',
      method: 'GET',
    });
    expect(decision?.rule.id).toBe('keep-real');
    expect(decision?.plan.kind).toBe('passthrough');
  });
});

describe('decideRequest', () => {
  it('pairs the winning rule with its resolved plan', () => {
    const decision = decideRequest(config([rule('a', '/v1/users')]), request);
    expect(decision?.rule.id).toBe('a');
    expect(decision?.plan).toMatchObject({ kind: 'respond', status: 404, statusText: 'Not Found' });
  });

  it('returns null when no rule applies', () => {
    expect(decideRequest(config([]), request)).toBeNull();
  });
});
