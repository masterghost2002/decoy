import { describe, expect, it } from 'vitest';

import { CONFIG_VERSION } from '../config.js';
import { loadConfig, mockRuleSchema, parseRule } from '../schema.js';

const validRule = {
  id: 'rule_1',
  name: 'Users 404',
  matcher: { url: { mode: 'contains', value: '/api/users' } },
  action: { kind: 'respond', status: 404, body: { type: 'json', value: '{}' } },
  createdAt: 1,
  updatedAt: 1,
};

describe('mockRuleSchema defaults', () => {
  it('fills in the fields a hand-written rule is allowed to omit', () => {
    const parsed = mockRuleSchema.parse(validRule);
    expect(parsed.enabled).toBe(true);
    expect(parsed.matcher.methods).toEqual(['*']);
    expect(parsed.matcher.url.caseSensitive).toBe(false);
    expect(parsed.action).toMatchObject({ statusText: '', headers: [], delayMs: 0 });
  });

  it('rejects a status a Response cannot be constructed with', () => {
    for (const status of [99, 100, 199, 600, 200.5]) {
      const result = mockRuleSchema.safeParse({
        ...validRule,
        action: { kind: 'respond', status, body: { type: 'empty' } },
      });
      expect(result.success, `status ${status} should be rejected`).toBe(false);
    }
  });

  it('rejects an unknown match mode or action kind', () => {
    expect(
      mockRuleSchema.safeParse({
        ...validRule,
        matcher: { url: { mode: 'glob', value: 'x' } },
      }).success,
    ).toBe(false);
    expect(
      mockRuleSchema.safeParse({ ...validRule, action: { kind: 'explode' } }).success,
    ).toBe(false);
  });
});

describe('parseRule', () => {
  it('returns null rather than throwing on junk', () => {
    expect(parseRule({ nope: true })).toBeNull();
    expect(parseRule(null)).toBeNull();
    expect(parseRule(parseRule(validRule))).not.toBeNull();
  });
});

describe('loadConfig', () => {
  it('keeps the good rules and reports the dropped ones', () => {
    const result = loadConfig({
      version: CONFIG_VERSION,
      enabled: true,
      rules: [validRule, { id: 'broken' }, { ...validRule, id: 'rule_2' }],
    });
    expect(result.reset).toBe(false);
    expect(result.droppedRules).toBe(1);
    expect(result.config.rules.map((rule) => rule.id)).toEqual(['rule_1', 'rule_2']);
  });

  it('falls back to defaults when the stored value is not a config at all', () => {
    for (const input of [null, 'nope', 42, [], { rules: 'not-an-array' }]) {
      const result = loadConfig(input);
      expect(result.reset, `${JSON.stringify(input)} should reset`).toBe(true);
      expect(result.config.rules).toEqual([]);
      expect(result.config.enabled).toBe(true);
    }
  });

  it('treats a missing rules list as an empty one', () => {
    const result = loadConfig({ version: CONFIG_VERSION, enabled: false });
    expect(result.reset).toBe(false);
    expect(result.config.enabled).toBe(false);
    expect(result.config.rules).toEqual([]);
  });

  it('always stamps the current config version', () => {
    expect(loadConfig({ version: 99, rules: [] }).config.version).toBe(CONFIG_VERSION);
  });
});
