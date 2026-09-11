import type { DecoyConfig } from './config.js';
import { matchesRequest, type InterceptedRequest } from './matching.js';
import { resolveAction, type MockPlan } from './resolve.js';
import type { MockRule } from './rule.js';

export interface RuleMatch {
  rule: MockRule;
  /** Position in the list, so a search can be resumed below it. */
  index: number;
}

/**
 * First enabled rule whose matcher accepts the request, at or after `from`, in
 * list order. Order is the whole priority model: no scores, no specificity
 * heuristics, just the list the user can see and reorder.
 *
 * `from` exists for one reason: a handler that calls `next()` has declined, and
 * what should answer instead is the next rule *below* it -- not the same rule
 * again, which would be an infinite loop, and not the whole list from the top,
 * which would find the same rule first. That single parameter is what makes a
 * handler at the top of the list behave like middleware over everything under
 * it, using the priority model that already exists.
 */
export function findMatchingRuleFrom(
  config: DecoyConfig,
  request: InterceptedRequest,
  from = 0,
): RuleMatch | null {
  if (!config.enabled) return null;

  for (let index = Math.max(0, from); index < config.rules.length; index += 1) {
    const rule = config.rules[index];
    if (rule === undefined) continue;
    if (!rule.enabled) continue;
    if (matchesRequest(rule.matcher, request)) return { rule, index };
  }
  return null;
}

export function findMatchingRule(
  config: DecoyConfig,
  request: InterceptedRequest,
): MockRule | null {
  return findMatchingRuleFrom(config, request, 0)?.rule ?? null;
}

export interface RuleDecision {
  rule: MockRule;
  /** Position of `rule`, so `next()` knows where to resume. */
  index: number;
  plan: MockPlan;
}

/** `null` means "no rule applies, let the real network handle it". */
export function decideRequest(
  config: DecoyConfig,
  request: InterceptedRequest,
  from = 0,
): RuleDecision | null {
  const match = findMatchingRuleFrom(config, request, from);
  if (match === null) return null;
  return { rule: match.rule, index: match.index, plan: resolveAction(match.rule.action) };
}
