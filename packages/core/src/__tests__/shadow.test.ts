import { describe, expect, it } from 'vitest';

import type { ConditionMode, RuleCondition } from '../conditions.js';
import type { MethodPattern } from '../http.js';
import type { UrlMatchMode } from '../matching.js';
import type { MockRule, RuleAction } from '../rule.js';
import { findShadowedRules, firstUrlMatch, ruleCovers } from '../shadow.js';

interface RuleOptions {
  mode?: UrlMatchMode;
  caseSensitive?: boolean;
  methods?: MethodPattern[];
  enabled?: boolean;
  conditions?: RuleCondition[];
  conditionMode?: ConditionMode;
  action?: RuleAction;
}

function rule(id: string, value: string, options: RuleOptions = {}): MockRule {
  return {
    id,
    name: id,
    enabled: options.enabled ?? true,
    matcher: {
      url: {
        mode: options.mode ?? 'contains',
        value,
        caseSensitive: options.caseSensitive ?? false,
      },
      methods: options.methods ?? ['*'],
      conditions: options.conditions ?? [],
      conditionMode: options.conditionMode ?? 'all',
    },
    action: options.action ?? { kind: 'passthrough' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function condition(overrides: Partial<RuleCondition> = {}): RuleCondition {
  return {
    id: 'cond',
    source: 'header',
    key: 'authorization',
    operator: 'exists',
    value: '',
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

describe('ruleCovers', () => {
  it('covers a longer contains pattern with a shorter one', () => {
    expect(ruleCovers(rule('a', '/api'), rule('b', '/api/users'))).toBe(true);
    expect(ruleCovers(rule('a', '/api/users'), rule('b', '/api'))).toBe(false);
  });

  it('covers equals, startsWith and endsWith with a contains substring', () => {
    expect(
      ruleCovers(rule('a', '/api'), rule('b', 'app.local/api/users', { mode: 'equals' })),
    ).toBe(true);
    expect(
      ruleCovers(rule('a', '/api'), rule('b', 'https://app.local/api', { mode: 'startsWith' })),
    ).toBe(true);
    expect(ruleCovers(rule('a', 'users'), rule('b', '/api/users', { mode: 'endsWith' }))).toBe(
      true,
    );
  });

  it('covers a longer prefix with a shorter prefix', () => {
    const outer = rule('a', 'https://app.local/api', { mode: 'startsWith' });
    const inner = rule('b', 'https://app.local/api/users', { mode: 'startsWith' });
    expect(ruleCovers(outer, inner)).toBe(true);
    expect(ruleCovers(inner, outer)).toBe(false);
  });

  it('covers an identical equals pattern but not a different one', () => {
    const options = { mode: 'equals' as const };
    expect(ruleCovers(rule('a', '/api/me', options), rule('b', '/api/me', options))).toBe(true);
    expect(ruleCovers(rule('a', '/api/me', options), rule('b', '/api/you', options))).toBe(false);
  });

  it('never claims to cover a wildcard or regex haystack', () => {
    expect(ruleCovers(rule('a', '/api/*', { mode: 'wildcard' }), rule('b', '/api/users'))).toBe(
      false,
    );
    expect(ruleCovers(rule('a', '/api/.*', { mode: 'regex' }), rule('b', '/api/users'))).toBe(
      false,
    );
  });

  it('treats a bare wildcard as universal', () => {
    expect(ruleCovers(rule('a', '*', { mode: 'wildcard' }), rule('b', '/api/users'))).toBe(true);
    expect(
      ruleCovers(rule('a', '*', { mode: 'wildcard' }), rule('b', '/x', { mode: 'regex' })),
    ).toBe(true);
  });

  it('requires the outer method set to cover the inner one', () => {
    expect(ruleCovers(rule('a', '/api'), rule('b', '/api/users', { methods: ['GET'] }))).toBe(true);
    expect(
      ruleCovers(
        rule('a', '/api', { methods: ['GET'] }),
        rule('b', '/api/users', { methods: ['GET', 'POST'] }),
      ),
    ).toBe(false);
    expect(
      ruleCovers(
        rule('a', '/api', { methods: ['GET'] }),
        rule('b', '/api/users', { methods: ['*'] }),
      ),
    ).toBe(false);
    expect(
      ruleCovers(
        rule('a', '/api', { methods: ['GET', 'POST'] }),
        rule('b', '/api/users', { methods: ['POST'] }),
      ),
    ).toBe(true);
  });

  it('refuses to shadow when the outer rule carries an enabled condition', () => {
    const outer = rule('a', '/api', { conditions: [condition()] });
    expect(ruleCovers(outer, rule('b', '/api/users'))).toBe(false);

    const disabled = rule('a', '/api', { conditions: [condition({ enabled: false })] });
    expect(ruleCovers(disabled, rule('b', '/api/users'))).toBe(true);
  });

  it('still shadows when only the inner rule is narrowed by conditions', () => {
    const inner = rule('b', '/api/users', { conditions: [condition()] });
    expect(ruleCovers(rule('a', '/api'), inner)).toBe(true);
  });

  it('will not let a case-sensitive rule shadow a case-insensitive one', () => {
    const outer = rule('a', '/API', { caseSensitive: true });
    expect(ruleCovers(outer, rule('b', '/API/users', { caseSensitive: false }))).toBe(false);
    expect(ruleCovers(outer, rule('b', '/API/users', { caseSensitive: true }))).toBe(true);
  });

  it('folds case when the outer rule is case-insensitive', () => {
    expect(ruleCovers(rule('a', '/api'), rule('b', '/API/USERS', { caseSensitive: true }))).toBe(
      true,
    );
  });

  it('never treats an empty pattern as covering anything', () => {
    expect(ruleCovers(rule('a', ''), rule('b', '/api/users'))).toBe(false);
    expect(ruleCovers(rule('a', '/api'), rule('b', ''))).toBe(false);
  });
});

describe('findShadowedRules', () => {
  it('names the first enabled rule that swallows a later one', () => {
    const rules = [
      rule('keep', '/api/users/me', { mode: 'equals' }),
      rule('broad', '/api'),
      rule('narrow', '/api/orders'),
    ];

    const shadowed = findShadowedRules(rules);
    expect(Object.keys(shadowed)).toEqual(['narrow']);
    expect(shadowed['narrow']).toEqual({
      ruleId: 'narrow',
      shadowedBy: 'broad',
      shadowedByIndex: 1,
    });
  });

  it('ignores disabled rules on both sides', () => {
    expect(findShadowedRules([rule('broad', '/api', { enabled: false }), rule('narrow', '/api/x')])) //
      .toEqual({});
    expect(
      findShadowedRules([rule('broad', '/api'), rule('narrow', '/api/x', { enabled: false })]),
    ).toEqual({});
  });

  it('reports the earliest shadowing rule, not the closest', () => {
    const rules = [
      rule('first', '/api'),
      rule('second', '/api/v1'),
      rule('third', '/api/v1/users'),
    ];
    expect(findShadowedRules(rules)['third']?.shadowedBy).toBe('first');
  });

  it('leaves independent rules alone', () => {
    const rules = [rule('a', '/api/users'), rule('b', '/api/orders')];
    expect(findShadowedRules(rules)).toEqual({});
  });
});

describe('firstUrlMatch', () => {
  it('names the winning rule and its position', () => {
    const rules = [rule('me', '/api/users/me'), rule('users', '/api/users')];
    const outcome = firstUrlMatch(rules, 'https://app.local/api/users?page=2');
    expect(outcome.rule?.id).toBe('users');
    expect(outcome.index).toBe(1);
    expect(outcome.uncertain).toBe(false);
  });

  it('skips disabled rules', () => {
    const rules = [rule('off', '/api', { enabled: false }), rule('on', '/api')];
    expect(firstUrlMatch(rules, 'https://app.local/api').rule?.id).toBe('on');
  });

  it('flags the answer as uncertain when an earlier match is method-narrowed', () => {
    const rules = [rule('post', '/api/users', { methods: ['POST'] }), rule('any', '/api/users')];
    const outcome = firstUrlMatch(rules, 'https://app.local/api/users');
    expect(outcome.rule?.id).toBe('any');
    expect(outcome.uncertain).toBe(true);
  });

  it('flags uncertainty when an earlier match carries conditions', () => {
    const rules = [
      rule('conditional', '/api/users', { conditions: [condition()] }),
      rule('plain', '/api/users'),
    ];
    expect(firstUrlMatch(rules, 'https://app.local/api/users').uncertain).toBe(true);
  });

  it('reports no winner when nothing matches', () => {
    const outcome = firstUrlMatch([rule('a', '/api/orders')], 'https://app.local/api/users');
    expect(outcome.rule).toBeNull();
    expect(outcome.index).toBe(-1);
    expect(outcome.uncertain).toBe(false);
  });
});
