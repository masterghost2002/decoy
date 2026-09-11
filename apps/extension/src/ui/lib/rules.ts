import {
  createId,
  type MethodPattern,
  type MockRule,
  type MocksmithConfig,
  type TrafficEntry,
} from '@mocksmith/core';

/**
 * Every editor action is a pure config transform. Keeping them here means the
 * components never hand-splice arrays, and rule ordering -- which is the whole
 * priority model -- stays testable.
 */

export function setMasterEnabled(config: MocksmithConfig, enabled: boolean): MocksmithConfig {
  return { ...config, enabled };
}

export function upsertRule(config: MocksmithConfig, rule: MockRule, now: number): MocksmithConfig {
  const stamped: MockRule = { ...rule, updatedAt: now };
  const index = config.rules.findIndex((candidate) => candidate.id === rule.id);

  if (index === -1) {
    return { ...config, rules: [...config.rules, stamped] };
  }

  const rules = [...config.rules];
  rules[index] = stamped;
  return { ...config, rules };
}

export function removeRule(config: MocksmithConfig, ruleId: string): MocksmithConfig {
  return { ...config, rules: config.rules.filter((rule) => rule.id !== ruleId) };
}

export function setRuleEnabled(
  config: MocksmithConfig,
  ruleId: string,
  enabled: boolean,
  now: number,
): MocksmithConfig {
  return {
    ...config,
    rules: config.rules.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled, updatedAt: now } : rule,
    ),
  };
}

/** Moves a rule by `offset` positions, clamped to the ends of the list. */
export function moveRule(
  config: MocksmithConfig,
  ruleId: string,
  offset: number,
): MocksmithConfig {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  if (index === -1) return config;

  const target = index + offset;
  if (target < 0 || target >= config.rules.length) return config;

  const rules = [...config.rules];
  const [moved] = rules.splice(index, 1);
  if (moved === undefined) return config;
  rules.splice(target, 0, moved);
  return { ...config, rules };
}

/** Inserts a copy directly below the original, disabled so it cannot surprise. */
export function duplicateRule(
  config: MocksmithConfig,
  ruleId: string,
  now: number,
): { config: MocksmithConfig; newRuleId: string | null } {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  const original = config.rules[index];
  if (original === undefined) return { config, newRuleId: null };

  const copy: MockRule = {
    ...original,
    id: createId('rule'),
    name: `${original.name} (copy)`,
    enabled: false,
    createdAt: now,
    updatedAt: now,
  };

  const rules = [...config.rules];
  rules.splice(index + 1, 0, copy);
  return { config: { ...config, rules }, newRuleId: copy.id };
}

export function countEnabledRules(config: MocksmithConfig): number {
  return config.rules.reduce((total, rule) => (rule.enabled ? total + 1 : total), 0);
}

/**
 * Seeds a rule from an observed request. Mirrors the status it actually
 * returned, which is the least surprising starting point for "now let me change
 * what this endpoint does".
 */
export function ruleFromTrafficEntry(entry: TrafficEntry, now: number): MockRule {
  let path = entry.url;
  try {
    path = new URL(entry.url).pathname;
  } catch {
    // Keep the raw url if it will not parse.
  }

  return {
    id: createId('rule'),
    name: `Mock ${entry.method} ${path}`,
    enabled: true,
    matcher: {
      url: { mode: 'contains', value: path, caseSensitive: false },
      methods: [entry.method as MethodPattern],
    },
    action: {
      kind: 'respond',
      status: entry.status ?? 200,
      statusText: '',
      headers: [],
      body: { type: 'json', value: '{}' },
      delayMs: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}
