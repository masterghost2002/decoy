import { createId } from './id.js';
import type {
  HandlerAction,
  NetworkErrorType,
  RespondAction,
  ResponseHeader,
  RuleAction,
  StreamChunk,
  StreamFormat,
} from './rule.js';

/**
 * The contract between a user-written handler and the rest of Decoy.
 *
 * A handler is a JavaScript function the user writes, which answers a request
 * the way an Express route would. Everything in this file is pure data: the
 * function itself does not run here, it runs in a sandboxed extension page --
 * the only context where both MV3's own content security policy and a hardened
 * site's policy permit compiling a string into a function. So the request
 * crosses a `postMessage` boundary on the way in and the outcome crosses it on
 * the way back, and both have to be structured-cloneable.
 *
 * The important design decision is at the bottom: an outcome is normalized into
 * an ordinary `RuleAction`. Delays, framing, content types, streaming over XHR,
 * the traffic log -- all of it is machinery that already exists and is already
 * tested, and a handler is just a new way to arrive at the same answer.
 */

/** Past this, the code is not a mock handler and storing it is a mistake. */
export const MAX_HANDLER_CODE_CHARS = 64 * 1024;

/**
 * How long a handler gets before it is treated as hung. Generous for anything
 * doing real work, short enough that a `while (true)` does not leave the page's
 * own `fetch` pending for a noticeable time.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 2000;
export const MAX_HANDLER_TIMEOUT_MS = 60_000;

/**
 * What the handler is given. Deliberately the same facts the matcher's
 * conditions see, so "why did this not match?" and "what did my handler get?"
 * never have two different answers.
 */
export interface HandlerRequest {
  method: string;
  /** The absolute url, exactly as the page asked for it. */
  url: string;
  /** Path only: no origin, no query. */
  path: string;
  host: string;
  origin: string;
  /** Query parameters. The last value wins, which is what callers expect. */
  query: Record<string, string>;
  /** Every value for every parameter, for the rare `?id=1&id=2`. */
  queryAll: Record<string, string[]>;
  /** Lowercased names. A header a page cannot read back is simply absent. */
  headers: Record<string, string>;
  cookies: Record<string, string>;
  /** The serialized payload, or null when there was none. */
  body: string | null;
  transport: 'fetch' | 'xhr';
  /** Epoch ms when the page made the call. */
  startedAt: number;
  /**
   * Captures from the rule's own url pattern: named groups in `regex` mode,
   * and positional `*` / `?` captures in `wildcard` mode under "0", "1", ...
   * This is what makes `/users/(?<id>\d+)` behave like an Express route.
   */
  params: Record<string, string>;
}

export interface HandlerRespondOutcome {
  kind: 'respond';
  status: number;
  statusText: string;
  headers: ResponseHeader[];
  /** Already serialized. `null` means no body at all. */
  body: string | null;
  bodyType: 'json' | 'text';
  delayMs: number;
}

export interface HandlerStreamOutcome {
  kind: 'stream';
  status: number;
  statusText: string;
  headers: ResponseHeader[];
  chunks: string[];
  format: StreamFormat;
  delayMs: number;
  intervalMs: number;
  repeat: number;
}

export interface HandlerFailOutcome {
  kind: 'fail';
  errorType: NetworkErrorType;
  delayMs: number;
}

export interface HandlerPassthroughOutcome {
  kind: 'passthrough';
}

/**
 * The handler declined to answer. The search continues *below* the rule that
 * ran, which is what makes a handler at the top of the list behave exactly like
 * a piece of middleware over everything under it -- without collections, and
 * without a second priority model to learn.
 */
export interface HandlerNextOutcome {
  kind: 'next';
}

export type HandlerOutcome =
  | HandlerRespondOutcome
  | HandlerStreamOutcome
  | HandlerFailOutcome
  | HandlerPassthroughOutcome
  | HandlerNextOutcome;

/**
 * Builds what the handler sees from what the interceptor already gathered.
 *
 * Pure, and in core rather than in the page, for one reason: this is the
 * handler's entire view of the world, and the shape of it is worth a test
 * rather than a browser.
 */
export function buildHandlerRequest(
  facts: {
    url: string;
    method: string;
    headers?: Readonly<Record<string, string>>;
    cookies?: Readonly<Record<string, string>>;
    body?: string | null;
  },
  extra: {
    transport: 'fetch' | 'xhr';
    startedAt: number;
    params?: Record<string, string>;
  },
): HandlerRequest {
  const query: Record<string, string> = {};
  const queryAll: Record<string, string[]> = {};
  let path = facts.url;
  let host = '';
  let origin = '';

  try {
    const parsed = new URL(facts.url);
    path = parsed.pathname;
    host = parsed.host;
    origin = parsed.origin;
    for (const [key, value] of parsed.searchParams) {
      query[key] = value;
      (queryAll[key] ??= []).push(value);
    }
  } catch {
    // A url that will not parse still gets a handler: the raw string is the
    // path, and query and host are simply empty. Refusing to run the code
    // would be a worse answer than running it with less.
    const queryStart = facts.url.indexOf('?');
    if (queryStart !== -1) path = facts.url.slice(0, queryStart);
  }

  return {
    method: facts.method,
    url: facts.url,
    path,
    host,
    origin,
    query,
    queryAll,
    headers: { ...(facts.headers ?? {}) },
    cookies: { ...(facts.cookies ?? {}) },
    body: facts.body ?? null,
    transport: extra.transport,
    startedAt: extra.startedAt,
    params: extra.params ?? {},
  };
}

/* -------------------------------------------------------------------------- */
/* The sandbox protocol                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Tags every message to and from the sandbox frame. The page shares `window`
 * with the site, so anything arriving without this is somebody else's traffic.
 */
export const HANDLER_CHANNEL = 'decoy.handler.v1';

export interface HandlerCallMessage {
  channel: typeof HANDLER_CHANNEL;
  kind: 'call';
  /** Correlates the reply. One sandbox serves every rule and every request. */
  id: string;
  ruleId: string;
  code: string;
  request: HandlerRequest;
  timeoutMs: number;
}

export interface HandlerResultMessage {
  channel: typeof HANDLER_CHANNEL;
  kind: 'result';
  id: string;
  outcome: HandlerOutcome;
}

export interface HandlerErrorMessage {
  channel: typeof HANDLER_CHANNEL;
  kind: 'error';
  id: string;
  /** Already formatted for a human: this is what the traffic log will show. */
  message: string;
  /** `true` when the code did not compile, as opposed to throwing when it ran. */
  compileError: boolean;
}

/**
 * A `console` call from inside a handler. The sandbox is a separate frame, so
 * its console output lands in a DevTools context nobody is looking at; these
 * are forwarded to the page's own console instead, where the person debugging
 * already is.
 */
export interface HandlerLogMessage {
  channel: typeof HANDLER_CHANNEL;
  kind: 'log';
  id: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** Pre-formatted, because arbitrary arguments are not cloneable. */
  text: string;
}

export interface HandlerReadyMessage {
  channel: typeof HANDLER_CHANNEL;
  kind: 'ready';
}

export type HandlerMessage =
  | HandlerCallMessage
  | HandlerResultMessage
  | HandlerErrorMessage
  | HandlerLogMessage
  | HandlerReadyMessage;

function isChannelMessage(data: unknown): data is { channel: string; kind: string } {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return candidate['channel'] === HANDLER_CHANNEL && typeof candidate['kind'] === 'string';
}

export function isHandlerCallMessage(data: unknown): data is HandlerCallMessage {
  return isChannelMessage(data) && data.kind === 'call';
}

export function isHandlerReplyMessage(
  data: unknown,
): data is HandlerResultMessage | HandlerErrorMessage | HandlerLogMessage | HandlerReadyMessage {
  if (!isChannelMessage(data)) return false;
  return (
    data.kind === 'result' || data.kind === 'error' || data.kind === 'log' || data.kind === 'ready'
  );
}

/* -------------------------------------------------------------------------- */
/* Outcome -> action                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Turns what the handler decided into an ordinary action, so everything
 * downstream -- plans, delays, stream framing, the XHR lifecycle, the traffic
 * log -- is the same code path a hand-built rule takes.
 *
 * `null` means the handler passed: the caller continues the search below it.
 */
export function actionFromHandlerOutcome(
  outcome: HandlerOutcome,
): Exclude<RuleAction, HandlerAction> | null {
  if (outcome.kind === 'next') return null;

  if (outcome.kind === 'passthrough') return { kind: 'passthrough' };

  if (outcome.kind === 'fail') {
    return { kind: 'networkError', errorType: outcome.errorType, delayMs: outcome.delayMs };
  }

  if (outcome.kind === 'stream') {
    return {
      kind: 'stream',
      status: outcome.status,
      statusText: outcome.statusText,
      headers: outcome.headers,
      format: outcome.format,
      chunks: outcome.chunks.map((value): StreamChunk => ({ id: createId('chunk'), value })),
      delayMs: outcome.delayMs,
      intervalMs: outcome.intervalMs,
      repeat: outcome.repeat,
    };
  }

  return {
    kind: 'respond',
    status: outcome.status,
    statusText: outcome.statusText,
    headers: outcome.headers,
    body:
      outcome.body === null
        ? { type: 'empty' }
        : { type: outcome.bodyType, value: outcome.body },
    delayMs: outcome.delayMs,
  };
}

/**
 * What a handler that threw, failed to compile, or never came back answers
 * with.
 *
 * Not a passthrough, which is the tempting choice: a handler that crashed and
 * then quietly let the request reach the real API can mutate real data, and it
 * hides the bug behind a working-looking app. A 500 naming the error is
 * attributable, harmless, and lands in the traffic log next to the rule that
 * produced it.
 */
export function handlerErrorAction(message: string): RespondAction {
  return {
    kind: 'respond',
    status: 500,
    statusText: 'Decoy Handler Error',
    headers: [{ name: 'X-Decoy-Error', value: 'handler' }],
    body: {
      type: 'json',
      value: JSON.stringify({ error: 'Decoy handler failed', detail: message }, null, 2),
    },
    delayMs: 0,
  };
}
