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

export const STREAM_FORMATS = ['sse', 'ndjson', 'text'] as const;
export type StreamFormat = (typeof STREAM_FORMATS)[number];

/**
 * One piece of a streamed body. Stored with an id so the editor can reorder and
 * delete rows without the list re-keying itself on every keystroke.
 */
export interface StreamChunk {
  id: string;
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
 * Deliver the body a piece at a time instead of all at once.
 *
 * A response that arrives complete is a different thing to test than one that
 * trickles: progressive rendering, back-pressure, an event source that has to
 * survive a reconnect. `respond` cannot express any of that, because it hands
 * over a finished string.
 *
 * The head -- status, reason phrase and headers -- arrives after `delayMs`.
 * Chunks then follow one every `intervalMs`, starting immediately, and the
 * whole list repeats `repeat` times. Zero repeats mean the stream never ends,
 * which is the honest way to mock a long-lived event source.
 */
export interface StreamAction {
  kind: 'stream';
  status: number;
  statusText: string;
  headers: ResponseHeader[];
  /** Decides how each chunk is framed on the wire, and the default content type. */
  format: StreamFormat;
  chunks: StreamChunk[];
  /** Before the response head arrives. */
  delayMs: number;
  /** Between one chunk and the next. */
  intervalMs: number;
  /** How many times the chunk list is sent. 0 means "until the caller gives up". */
  repeat: number;
}

/**
 * Answer with a JavaScript function the user wrote.
 *
 * The declarative actions cover "this endpoint returns this" completely, and
 * badly cover everything that depends on the request: a different answer per
 * user, a paginated list, the third call failing, a token that has to match the
 * one just issued. Those need code, and the alternative to writing it here is
 * standing up a real server -- which is a different project, a different
 * lifecycle, and a proxy in front of the app.
 *
 * The code runs in a sandboxed extension page, not in the page and not in the
 * worker; see `handler.ts` for the contract and why that is the only place it
 * can run at all.
 */
export interface HandlerAction {
  kind: 'handler';
  /** The user's source. Statements, or a function; see `compileHandler`. */
  code: string;
  /** Before the handler is even called, so `delay` composes with `res.delay`. */
  delayMs: number;
  /** How long the handler gets before it is treated as hung. */
  timeoutMs: number;
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

export type RuleAction =
  | RespondAction
  | StreamAction
  | HandlerAction
  | NetworkErrorAction
  | PassthroughAction;
export type RuleActionKind = RuleAction['kind'];

/**
 * True when two rules carry the same *edits* -- the fields a form changes.
 *
 * Not the same as deep equality, and the difference is a bug that was shipped:
 * saving stamps a fresh `updatedAt` on the stored rule, so a draft compared
 * whole against it never matches again and the Save button stays lit forever,
 * on a form with nothing left to save.
 *
 * `enabled` is excluded for a second reason. It is owned by the switch in the
 * list, not by the form, so flipping it while a rule is open would otherwise
 * mark the form dirty -- and saving would then quietly put the old value back.
 */
export function ruleEditsEqual(a: MockRule, b: MockRule): boolean {
  if (a.name !== b.name) return false;
  return (
    JSON.stringify(a.matcher) === JSON.stringify(b.matcher) &&
    JSON.stringify(a.action) === JSON.stringify(b.action)
  );
}

/**
 * The saved rule, carrying the draft's edits. Everything the form does not own
 * -- `enabled` above all -- is taken from the rule as it stands now, so a save
 * cannot revert a switch someone flipped while the form was open.
 */
export function applyRuleEdits(current: MockRule, draft: MockRule): MockRule {
  return { ...current, name: draft.name, matcher: draft.matcher, action: draft.action };
}

export interface MockRule {
  id: string;
  name: string;
  enabled: boolean;
  matcher: RequestMatcher;
  action: RuleAction;
  createdAt: number;
  updatedAt: number;
}
