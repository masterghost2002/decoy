import { createId } from './id.js';
import { METHOD_ANY } from './http.js';
import type { MockRule, NetworkErrorType, RuleAction } from './rule.js';

export function createRespondAction(status = 200): Extract<RuleAction, { kind: 'respond' }> {
  return {
    kind: 'respond',
    status,
    statusText: '',
    headers: [],
    body: { type: 'json', value: '{}' },
    delayMs: 0,
  };
}

export function createNetworkErrorAction(
  errorType: NetworkErrorType = 'failed',
): Extract<RuleAction, { kind: 'networkError' }> {
  return { kind: 'networkError', errorType, delayMs: 0 };
}

/** A blank rule for the editor. Enabled, because a rule you just created and
 * cannot see working is worse than one that fires immediately. */
export function createRule(now: number, name = 'New rule'): MockRule {
  return {
    id: createId('rule'),
    name,
    enabled: true,
    matcher: {
      url: { mode: 'contains', value: '', caseSensitive: false },
      methods: [METHOD_ANY],
    },
    action: createRespondAction(200),
    createdAt: now,
    updatedAt: now,
  };
}
