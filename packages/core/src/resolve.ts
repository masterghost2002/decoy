import { defaultStatusText, statusForbidsBody } from './http.js';
import type { NetworkErrorType, RuleAction } from './rule.js';

/**
 * A transport-neutral description of what to do with one request. The engine
 * produces plans; the fetch/XHR layers turn them into a Response or an error.
 */
export interface RespondPlan {
  kind: 'respond';
  status: number;
  statusText: string;
  /** Ordered tuples, so duplicate header names survive. */
  headers: Array<[string, string]>;
  body: string | null;
  delayMs: number;
}

export interface NetworkErrorPlan {
  kind: 'networkError';
  errorType: NetworkErrorType;
  delayMs: number;
}

export interface PassthroughPlan {
  kind: 'passthrough';
}

export type MockPlan = RespondPlan | NetworkErrorPlan | PassthroughPlan;

const CONTENT_TYPE = 'content-type';

function contentTypeFor(bodyType: 'json' | 'text'): string {
  return bodyType === 'json' ? 'application/json' : 'text/plain;charset=utf-8';
}

export function resolveAction(action: RuleAction): MockPlan {
  if (action.kind === 'passthrough') return { kind: 'passthrough' };

  if (action.kind === 'networkError') {
    return {
      kind: 'networkError',
      errorType: action.errorType,
      delayMs: Math.max(0, action.delayMs),
    };
  }

  const headers: Array<[string, string]> = [];
  let hasContentType = false;
  for (const header of action.headers) {
    const name = header.name.trim();
    if (name.length === 0) continue;
    if (name.toLowerCase() === CONTENT_TYPE) hasContentType = true;
    headers.push([name, header.value]);
  }

  const bodySpec = action.body;
  let body: string | null = bodySpec.type === 'empty' ? null : bodySpec.value;

  // Only default the content type when the rule did not state one, so an
  // explicit override always wins.
  if (bodySpec.type !== 'empty' && !hasContentType) {
    headers.push([CONTENT_TYPE, contentTypeFor(bodySpec.type)]);
  }

  // Constructing a Response with a body on these statuses throws.
  if (statusForbidsBody(action.status)) body = null;

  return {
    kind: 'respond',
    status: action.status,
    statusText: action.statusText.length > 0 ? action.statusText : defaultStatusText(action.status),
    headers,
    body,
    delayMs: Math.max(0, action.delayMs),
  };
}
