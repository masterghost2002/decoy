import type { MocksmithConfig } from './config.js';
import { matchesRequest, type InterceptedRequest } from './matching.js';
import { resolveAction, type MockPlan } from './resolve.js';
import type { MockRule } from './rule.js';

/**
 * First enabled rule whose matcher accepts the request, in list order. Order is
 * the whole priority model: no scores, no specificity heuristics, just the list
 * the user can see and reorder.
 */
export function findMatchingRule(
  config: MocksmithConfig,
  request: InterceptedRequest,
): MockRule | null {
  if (!config.enabled) return null;

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (matchesRequest(rule.matcher, request)) return rule;
  }
  return null;
}

export interface RuleDecision {
  rule: MockRule;
  plan: MockPlan;
}

/** `null` means "no rule applies, let the real network handle it". */
export function decideRequest(
  config: MocksmithConfig,
  request: InterceptedRequest,
): RuleDecision | null {
  const rule = findMatchingRule(config, request);
  if (rule === null) return null;
  return { rule, plan: resolveAction(rule.action) };
}
