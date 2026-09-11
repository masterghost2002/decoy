import {
  DEFAULT_HANDLER_TIMEOUT_MS,
  type HandlerOutcome,
  type NetworkErrorType,
  type ResponseHeader,
  type StreamFormat,
} from '@mocksmith/core';

/**
 * The `res` object a handler is given, and the rules for reading what it
 * returned.
 *
 * The shape is Express's on purpose. Not for novelty -- because the person
 * writing a mock handler has almost certainly written a route handler, and
 * every convention they already know is one thing they do not have to look up:
 * `res.status(404).json(...)`, `res.send(...)`, `next()`.
 *
 * Two ways to answer, both valid, because both are habits people have:
 * returning the response (`return res.json(x)`) and just sending it
 * (`res.json(x)`). And returning a plain value is the shortest path of all:
 * `return { items: [] }` is a 200 with that json body.
 */

export interface StreamOptions {
  format?: StreamFormat;
  /** Milliseconds between chunks. Named for how it reads: `every: 250`. */
  every?: number;
  /** 0 keeps the stream open forever, which is the honest way to mock one. */
  repeat?: number;
}

export interface Responder {
  status: (code: number) => Responder;
  /** `set('X-Thing', '1')` or `set({ 'X-Thing': '1' })`. */
  set: (name: string | Record<string, string>, value?: string) => Responder;
  /** Delays the answer, on top of any delay the rule itself carries. */
  delay: (ms: number) => Responder;
  json: (value: unknown) => HandlerOutcome;
  text: (value: unknown) => HandlerOutcome;
  /** json for objects, text for everything else. */
  send: (value?: unknown) => HandlerOutcome;
  /** A status and nothing else. */
  sendStatus: (code: number) => HandlerOutcome;
  /** No body at all, and no content type. */
  end: () => HandlerOutcome;
  stream: (chunks: unknown[], options?: StreamOptions) => HandlerOutcome;
  fail: (errorType?: NetworkErrorType) => HandlerOutcome;
  passthrough: () => HandlerOutcome;
}

export interface ResponderHandle {
  res: Responder;
  next: () => HandlerOutcome;
  /** Whatever the handler sent, if it sent anything without returning it. */
  sent: () => HandlerOutcome | null;
  /** True for a value this responder produced, as opposed to user data. */
  owns: (value: unknown) => boolean;
  /**
   * The answer, given what the handler returned. This is where the three ways
   * of answering collapse into one outcome.
   */
  resolve: (returned: unknown) => HandlerOutcome;
}

function isPlainText(value: unknown): boolean {
  return typeof value === 'string';
}

function toBodyText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

export function createResponder(): ResponderHandle {
  let status = 200;
  const statusText = '';
  let delayMs = 0;
  const headers: ResponseHeader[] = [];

  /** Outcomes this responder made, so user data can never be mistaken for one. */
  const produced = new WeakSet<object>();
  let sent: HandlerOutcome | null = null;

  const finish = (outcome: HandlerOutcome): HandlerOutcome => {
    produced.add(outcome);
    // The first answer wins. A handler that sends twice has a bug, and the
    // second send arriving after the response is already on its way to the page
    // would be a lie either way.
    sent ??= outcome;
    return outcome;
  };

  const respond = (body: string | null, bodyType: 'json' | 'text'): HandlerOutcome =>
    finish({ kind: 'respond', status, statusText, headers: [...headers], body, bodyType, delayMs });

  const res: Responder = {
    status: (code) => {
      status = Math.trunc(code);
      return res;
    },
    set: (name, value) => {
      if (typeof name === 'object') {
        for (const [key, entry] of Object.entries(name)) {
          headers.push({ name: key, value: String(entry) });
        }
      } else if (value !== undefined) {
        headers.push({ name, value: String(value) });
      }
      return res;
    },
    delay: (ms) => {
      delayMs = Math.max(0, Math.trunc(ms));
      return res;
    },
    json: (value) => respond(toBodyText(value), 'json'),
    text: (value) => respond(typeof value === 'string' ? value : toBodyText(value), 'text'),
    send: (value) => {
      if (value === undefined) return respond(null, 'text');
      return respond(toBodyText(value), isPlainText(value) ? 'text' : 'json');
    },
    sendStatus: (code) => {
      status = Math.trunc(code);
      return respond(null, 'text');
    },
    end: () => respond(null, 'text'),
    stream: (chunks, options) =>
      finish({
        kind: 'stream',
        status,
        statusText,
        headers: [...headers],
        chunks: chunks.map((chunk) => toBodyText(chunk)),
        format: options?.format ?? 'sse',
        delayMs,
        intervalMs: Math.max(0, Math.trunc(options?.every ?? 500)),
        repeat: Math.max(0, Math.trunc(options?.repeat ?? 1)),
      }),
    fail: (errorType) => finish({ kind: 'fail', errorType: errorType ?? 'failed', delayMs }),
    passthrough: () => finish({ kind: 'passthrough' }),
  };

  const next = (): HandlerOutcome => finish({ kind: 'next' });

  return {
    res,
    next,
    sent: () => sent,
    owns: (value) => typeof value === 'object' && value !== null && produced.has(value),
    resolve: (returned) => {
      // Returned one of ours: `return res.json(...)`, or `return next()`.
      if (typeof returned === 'object' && returned !== null && produced.has(returned)) {
        return returned as HandlerOutcome;
      }

      // Returned a plain value: that is the json body, and any status or header
      // set beforehand still applies.
      if (returned !== undefined && returned !== null) {
        return {
          kind: 'respond',
          status,
          statusText,
          headers: [...headers],
          body: toBodyText(returned),
          bodyType: isPlainText(returned) ? 'text' : 'json',
          delayMs,
        };
      }

      // Returned nothing, but sent something on the way through.
      if (sent !== null) return sent;

      // Returned nothing and sent nothing. Falling through is the only sane
      // reading: it is what middleware does, and it is what lets a handler
      // answer some requests and leave the rest to the rules below it.
      return { kind: 'next' };
    },
  };
}

export const HANDLER_TIMEOUT_FALLBACK_MS = DEFAULT_HANDLER_TIMEOUT_MS;
