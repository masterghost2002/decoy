import { defaultStatusText, statusForbidsBody } from './http.js';
import type {
  HandlerAction,
  NetworkErrorType,
  ResponseHeader,
  RuleAction,
  StreamFormat,
} from './rule.js';

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

/**
 * The same head as a `RespondPlan`, but the body arrives as a sequence. Chunks
 * are already framed for the format, so the transport layer only has to decide
 * *when* to put each one on the wire, never what it should look like.
 */
export interface StreamPlan {
  kind: 'stream';
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  /** Encoded and in order: the exact text each chunk puts on the wire. */
  chunks: string[];
  /** Before the head arrives. */
  delayMs: number;
  /** Between chunks. The first one goes out as soon as the head does. */
  intervalMs: number;
  /** 0 means "keep going until the caller disconnects". */
  repeat: number;
}

export interface NetworkErrorPlan {
  kind: 'networkError';
  errorType: NetworkErrorType;
  delayMs: number;
}

export interface PassthroughPlan {
  kind: 'passthrough';
}

/**
 * The one plan that is not an answer but an instruction to go and get one.
 *
 * Deciding stays pure and synchronous -- it runs for every request the page
 * makes, against every rule -- so a handler cannot be executed inside it.
 * Instead the decision says "run this code", the transport (which is already
 * asynchronous) runs it, and the outcome is normalized back into an action and
 * resolved again. Everything after that second resolve is the ordinary path.
 */
export interface HandlerPlan {
  kind: 'handler';
  code: string;
  /** Applied before the handler is called, not after. */
  delayMs: number;
  timeoutMs: number;
}

export type MockPlan =
  | RespondPlan
  | StreamPlan
  | HandlerPlan
  | NetworkErrorPlan
  | PassthroughPlan;

/**
 * A plan that is an answer: everything except `handler`, which is an
 * instruction to go and find one.
 *
 * Worth its own name because it is the type every transport actually wants. A
 * handler plan is resolved away before delivery, and saying so here means the
 * fetch and XHR layers cannot accidentally be handed one -- the compiler
 * refuses instead of the request hanging.
 */
export type SettledPlan = Exclude<MockPlan, HandlerPlan>;

const CONTENT_TYPE = 'content-type';

function contentTypeFor(bodyType: 'json' | 'text'): string {
  return bodyType === 'json' ? 'application/json' : 'text/plain;charset=utf-8';
}

const STREAM_CONTENT_TYPE: Readonly<Record<StreamFormat, string>> = {
  sse: 'text/event-stream',
  ndjson: 'application/x-ndjson',
  text: 'text/plain;charset=utf-8',
};

/** A chunk that already names an SSE field is passed through as a raw event. */
const SSE_FIELD = /^(data|event|id|retry):|^:/;

/**
 * Frames one chunk for the wire.
 *
 * `sse` is the only format that rewrites what it is given, and only when it has
 * to: a value that already looks like an event is left alone, so a hand-written
 * `event: ping` still works, while a bare json payload gets the `data:` prefix
 * it would otherwise be missing.
 *
 * `ndjson` compacts valid json onto one line, because a pretty-printed record
 * spanning four lines is four broken records to the reader on the other end.
 * Anything that is not json is sent as written -- guessing at where the record
 * boundaries are in arbitrary text would be worse than the user's own newlines.
 */
export function encodeStreamChunk(format: StreamFormat, value: string): string {
  if (format === 'text') return value;

  if (format === 'ndjson') {
    const line = compactJson(value.trim());
    return line.length === 0 ? '' : `${line}\n`;
  }

  // A chunk of pure whitespace is a blank line, which in SSE terminates an
  // event that was never started -- so it is dropped rather than framed.
  if (value.trim().length === 0) return '';

  const trimmed = value.replace(/\n+$/, '');
  if (SSE_FIELD.test(trimmed.trimStart())) return `${trimmed}\n\n`;
  return `${trimmed
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`;
}

function compactJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

/**
 * Header pairs, with the format's content type appended unless the rule already
 * named one. Shared by both response plans so an explicit override always wins,
 * in exactly the same way, whichever kind of body follows.
 */
function planHeaders(
  headers: ResponseHeader[],
  fallbackContentType: string | null,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let hasContentType = false;
  for (const header of headers) {
    const name = header.name.trim();
    if (name.length === 0) continue;
    if (name.toLowerCase() === CONTENT_TYPE) hasContentType = true;
    pairs.push([name, header.value]);
  }
  if (fallbackContentType !== null && !hasContentType) {
    pairs.push([CONTENT_TYPE, fallbackContentType]);
  }
  return pairs;
}

export function resolveAction(action: Exclude<RuleAction, HandlerAction>): SettledPlan;
export function resolveAction(action: RuleAction): MockPlan;
export function resolveAction(action: RuleAction): MockPlan {
  if (action.kind === 'passthrough') return { kind: 'passthrough' };

  if (action.kind === 'networkError') {
    return {
      kind: 'networkError',
      errorType: action.errorType,
      delayMs: Math.max(0, action.delayMs),
    };
  }

  if (action.kind === 'handler') {
    return {
      kind: 'handler',
      code: action.code,
      delayMs: Math.max(0, action.delayMs),
      timeoutMs: Math.max(1, action.timeoutMs),
    };
  }

  if (action.kind === 'stream') {
    const forbidsBody = statusForbidsBody(action.status);
    return {
      kind: 'stream',
      status: action.status,
      statusText: statusTextFor(action.status, action.statusText),
      headers: planHeaders(action.headers, STREAM_CONTENT_TYPE[action.format]),
      // Empty chunks would put nothing on the wire but still cost an interval
      // each, which reads as a stalled stream rather than an empty one.
      chunks: forbidsBody
        ? []
        : action.chunks
            .map((chunk) => encodeStreamChunk(action.format, chunk.value))
            .filter((chunk) => chunk.length > 0),
      delayMs: Math.max(0, action.delayMs),
      intervalMs: Math.max(0, action.intervalMs),
      repeat: Math.max(0, Math.trunc(action.repeat)),
    };
  }

  const bodySpec = action.body;
  let body: string | null = bodySpec.type === 'empty' ? null : bodySpec.value;
  const headers = planHeaders(
    action.headers,
    bodySpec.type === 'empty' ? null : contentTypeFor(bodySpec.type),
  );

  // Constructing a Response with a body on these statuses throws.
  if (statusForbidsBody(action.status)) body = null;

  return {
    kind: 'respond',
    status: action.status,
    statusText: statusTextFor(action.status, action.statusText),
    headers,
    body,
    delayMs: Math.max(0, action.delayMs),
  };
}

function statusTextFor(status: number, explicit: string): string {
  return explicit.length > 0 ? explicit : defaultStatusText(status);
}
