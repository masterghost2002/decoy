import type { RequestMatcher } from './matching.js';

export const RESPONSE_BODY_TYPES = ['json', 'text', 'empty'] as const;
export type ResponseBodyType = (typeof RESPONSE_BODY_TYPES)[number];

/**
 * Bodies are always stored as raw strings, never parsed objects. Two reasons:
 * they stay trivially serializable, and a deliberately malformed JSON body
 * stays malformed, which is itself a case front-end code needs to handle.
 */
export type ResponseBody =
  | { type: 'json'; value: string }
  | { type: 'text'; value: string }
  | { type: 'empty' };

export interface ResponseHeader {
  name: string;
  value: string;
}

export const NETWORK_ERROR_TYPES = ['failed', 'timeout', 'aborted'] as const;
export type NetworkErrorType = (typeof NETWORK_ERROR_TYPES)[number];

/** Return a synthesized response instead of hitting the network. */
export interface RespondAction {
  kind: 'respond';
  status: number;
  /** Empty string means "use the conventional reason phrase for this status". */
  statusText: string;
  headers: ResponseHeader[];
  body: ResponseBody;
  delayMs: number;
}

/**
 * Fail the request the way the network would.
 * - `failed`  rejects with a TypeError, same as DNS failure or a CORS block
 * - `timeout` never settles, so the caller's own timeout logic runs
 * - `aborted` rejects with an AbortError
 */
export interface NetworkErrorAction {
  kind: 'networkError';
  errorType: NetworkErrorType;
  delayMs: number;
}

/**
 * Explicitly let the request through. Useful as a narrow exception placed above
 * a broad mock rule.
 */
export interface PassthroughAction {
  kind: 'passthrough';
}

export type RuleAction = RespondAction | NetworkErrorAction | PassthroughAction;
export type RuleActionKind = RuleAction['kind'];

export interface MockRule {
  id: string;
  name: string;
  enabled: boolean;
  matcher: RequestMatcher;
  action: RuleAction;
  createdAt: number;
  updatedAt: number;
}
