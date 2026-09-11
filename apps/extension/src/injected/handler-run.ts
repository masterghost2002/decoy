import {
  actionFromHandlerOutcome,
  buildHandlerRequest,
  decideRequest,
  handlerErrorAction,
  resolveAction,
  urlCaptures,
  type MockRule,
  type DecoyConfig,
  type RequestFacts,
  type RuleDecision,
  type SettledPlan,
} from '@decoy/core';

import type { HandlerClient } from './handler-client.js';

export interface SettledDecision {
  /** The rule that actually answered, which may be below the one that ran. */
  rule: MockRule;
  plan: SettledPlan;
  /** Set when a handler failed; the traffic log shows it next to the rule. */
  error: string | null;
}

export interface SettleOptions {
  config: DecoyConfig;
  facts: RequestFacts;
  decision: RuleDecision;
  client: HandlerClient;
  transport: 'fetch' | 'xhr';
  startedAt: number;
}

/**
 * Turns a decision into something a transport can deliver, running handlers as
 * needed.
 *
 * A handler may decline by calling `next()`, and what answers instead is the
 * next matching rule *below* it -- which may itself be a handler. So this is a
 * loop, and it terminates for a structural reason worth stating: each pass
 * resumes the search strictly after the index that just ran, so the list is
 * walked at most once. There is no cycle to guard against.
 *
 * `null` means every rule in the chain declined: the request belongs to the
 * real network after all.
 */
export async function settleDecision(options: SettleOptions): Promise<SettledDecision | null> {
  const { config, facts, client, transport, startedAt } = options;
  let current: RuleDecision = options.decision;

  for (;;) {
    if (current.plan.kind !== 'handler') {
      return { rule: current.rule, plan: current.plan, error: null };
    }

    const handlerPlan = current.plan;
    const result = await client.run({
      ruleId: current.rule.id,
      ruleName: current.rule.name,
      code: handlerPlan.code,
      timeoutMs: handlerPlan.timeoutMs,
      request: buildHandlerRequest(facts, {
        transport,
        startedAt,
        params: urlCaptures(current.rule.matcher.url, facts.url),
      }),
    });

    if (!result.ok) {
      return {
        rule: current.rule,
        plan: resolveAction(handlerErrorAction(result.message)),
        error: result.message,
      };
    }

    const action = actionFromHandlerOutcome(result.outcome);

    if (action === null) {
      const next = decideRequest(config, facts, current.index + 1);
      if (next === null) return null;
      current = next;
      continue;
    }

    // The rule's own delay is added to whatever the handler asked for, so a
    // rule set to 300ms stays slow however it produced its answer.
    return {
      rule: current.rule,
      plan: addDelay(resolveAction(action), handlerPlan.delayMs),
      error: null,
    };
  }
}

function addDelay(plan: SettledPlan, extraMs: number): SettledPlan {
  if (extraMs <= 0 || plan.kind === 'passthrough') return plan;
  return { ...plan, delayMs: plan.delayMs + extraMs };
}

/**
 * The answer for a handler that cannot be run at all, rather than one that ran
 * and failed. Kept beside the rest so both paths produce the same visible 500.
 */
export function unrunnableHandler(reason: string): SettledPlan {
  return resolveAction(handlerErrorAction(reason));
}
