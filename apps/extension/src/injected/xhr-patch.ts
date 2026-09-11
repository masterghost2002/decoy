import {
  capBody,
  decideRequest,
  type HeaderPair,
  type MockRule,
  type RequestFacts,
  type RespondPlan,
  type SettledPlan,
  type StreamPlan,
  type TrafficOutcome,
} from '@mocksmith/core';

import {
  assembleRequest,
  collectXhrBody,
  headersToPairs,
  parseRawHeaders,
  tuplesToPairs,
} from './facts.js';
import type { ConfigGate } from './config-gate.js';
import type { HandlerClient } from './handler-client.js';
import { settleDecision, unrunnableHandler } from './handler-run.js';
import type { Reporter } from './reporter.js';
import { buildHeaders } from './response.js';
import { absolutizeUrl } from './url.js';

export interface XhrPatchContext {
  gate: ConfigGate;
  report: Reporter;
  handlers: HandlerClient;
}

const UNSENT = 0;
const HEADERS_RECEIVED = 2;
const LOADING = 3;
const DONE = 4;

interface XhrState {
  method: string;
  url: string;
  isAsync: boolean;
  requestHeaders: Array<[string, string]>;
  /** Serialized payload, captured in `send()` and capped. */
  requestBody: string | null;
  requestBodyTruncated: boolean;
  startedAt: number;
  /** True once we have decided to answer this request ourselves. */
  mocked: boolean;
  aborted: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** Instance properties we defined, so a reused instance can be restored. */
  shadowed: Set<string>;
  /**
   * The body a rule answered with, kept so the traffic entry can carry it. By
   * the time the report goes out the instance's own `responseText` is shadowed,
   * and reading it back would be reading our own answer through two layers of
   * indirection.
   */
  mockedBody: string | null;
  /**
   * Set once a rule takes the request over. Every way the request can end --
   * delivered, failed, client timeout, aborted -- funnels through this, so a
   * request that never completed still shows up in the traffic log. That is
   * precisely the case someone is debugging.
   */
  reportTerminal:
    | ((outcome: TrafficOutcome, status: number | null, responseHeaders?: HeaderPair[]) => void)
    | null;
}

const states = new WeakMap<XMLHttpRequest, XhrState>();
const encoder = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* Instance shadowing                                                         */
/*                                                                            */
/* `status`, `responseText` and friends are read-only getters on the           */
/* prototype. A mocked request answers by defining own properties on the       */
/* instance, which take precedence, and deleting them again if the same        */
/* instance is later reopened.                                                 */
/* -------------------------------------------------------------------------- */

function defineOwn(xhr: XMLHttpRequest, state: XhrState, key: string, value: unknown): void {
  Object.defineProperty(xhr, key, { value, configurable: true, enumerable: true, writable: true });
  state.shadowed.add(key);
}

function defineOwnGetter(
  xhr: XMLHttpRequest,
  state: XhrState,
  key: string,
  get: () => unknown,
): void {
  Object.defineProperty(xhr, key, { get, configurable: true, enumerable: true });
  state.shadowed.add(key);
}

function restoreInstance(xhr: XMLHttpRequest, state: XhrState): void {
  for (const key of state.shadowed) {
    delete (xhr as unknown as Record<string, unknown>)[key];
  }
  state.shadowed.clear();
}

function clearTimers(state: XhrState): void {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
}

function schedule(state: XhrState, ms: number, run: () => void): void {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    run();
  }, ms);
  state.timers.add(timer);
}

function dispatch(xhr: XMLHttpRequest, type: string): void {
  xhr.dispatchEvent(new Event(type));
}

function dispatchProgress(xhr: XMLHttpRequest, type: string, loaded: number, total: number): void {
  xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: total > 0, loaded, total }));
}

/* -------------------------------------------------------------------------- */
/* Response shaping                                                           */
/* -------------------------------------------------------------------------- */

/** Spec format: lowercased names, sorted, CRLF separated, trailing CRLF. */
function serializeHeaders(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, name) => {
    lines.push(`${name.toLowerCase()}: ${value}`);
  });
  lines.sort();
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
}

function parseDocument(text: string, mimeType: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  const type = mimeType.includes('html')
    ? 'text/html'
    : mimeType.includes('xml') || mimeType.length === 0
      ? 'text/xml'
      : '';
  if (type === '') return null;
  try {
    const parsed = new DOMParser().parseFromString(text, type);
    return parsed.querySelector('parsererror') === null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Applies the body in the shape the caller asked for. Deliberately faithful to
 * the spec, including making `responseText` throw for binary response types: a
 * mock that is more forgiving than the network hides real bugs.
 */
function applyResponseBody(
  xhr: XMLHttpRequest,
  state: XhrState,
  text: string,
  mimeType: string,
): void {
  const responseType = xhr.responseType;

  if (responseType === '' || responseType === 'text') {
    defineOwn(xhr, state, 'responseText', text);
    defineOwn(xhr, state, 'response', text);
    defineOwn(xhr, state, 'responseXML', parseDocument(text, mimeType));
    return;
  }

  defineOwnGetter(xhr, state, 'responseText', () => {
    throw new DOMException(
      `Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${responseType}').`,
      'InvalidStateError',
    );
  });
  defineOwn(xhr, state, 'responseXML', null);

  switch (responseType) {
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Spec behaviour: an unparseable json response surfaces as null.
        parsed = null;
      }
      defineOwn(xhr, state, 'response', parsed);
      return;
    }
    case 'blob':
      defineOwn(xhr, state, 'response', new Blob([text], { type: mimeType }));
      return;
    case 'arraybuffer': {
      const encoded = encoder.encode(text);
      const buffer = new ArrayBuffer(encoded.byteLength);
      new Uint8Array(buffer).set(encoded);
      defineOwn(xhr, state, 'response', buffer);
      return;
    }
    case 'document':
      defineOwn(xhr, state, 'response', parseDocument(text, mimeType));
      return;
    default:
      defineOwn(xhr, state, 'response', text);
  }
}

function installHeaderAccessors(xhr: XMLHttpRequest, state: XhrState, headers: Headers): void {
  defineOwn(xhr, state, 'getResponseHeader', (name: string) => headers.get(name));
  defineOwn(xhr, state, 'getAllResponseHeaders', () => serializeHeaders(headers));
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

function finishWithFailure(
  xhr: XMLHttpRequest,
  state: XhrState,
  eventType: 'error' | 'timeout' | 'abort',
): void {
  clearTimers(state);
  defineOwn(xhr, state, 'readyState', DONE);
  defineOwn(xhr, state, 'status', 0);
  defineOwn(xhr, state, 'statusText', '');
  defineOwn(xhr, state, 'responseText', '');
  defineOwn(xhr, state, 'response', '');
  defineOwn(xhr, state, 'responseXML', null);
  installHeaderAccessors(xhr, state, new Headers());
  dispatch(xhr, 'readystatechange');
  dispatchProgress(xhr, eventType, 0, 0);
  dispatchProgress(xhr, 'loadend', 0, 0);
}

function deliverMockedResponse(xhr: XMLHttpRequest, state: XhrState, plan: RespondPlan): void {
  const headers = buildHeaders(plan.headers);
  const text = plan.body ?? '';
  const byteLength = encoder.encode(text).byteLength;
  const mimeType = headers.get('content-type') ?? '';

  defineOwn(xhr, state, 'status', plan.status);
  defineOwn(xhr, state, 'statusText', plan.statusText);
  defineOwn(xhr, state, 'responseURL', state.url);
  installHeaderAccessors(xhr, state, headers);

  defineOwn(xhr, state, 'readyState', HEADERS_RECEIVED);
  dispatch(xhr, 'readystatechange');

  applyResponseBody(xhr, state, text, mimeType);

  defineOwn(xhr, state, 'readyState', LOADING);
  dispatch(xhr, 'readystatechange');
  dispatchProgress(xhr, 'progress', byteLength, byteLength);

  defineOwn(xhr, state, 'readyState', DONE);
  dispatch(xhr, 'readystatechange');
  dispatchProgress(xhr, 'load', byteLength, byteLength);
  dispatchProgress(xhr, 'loadend', byteLength, byteLength);
}

/**
 * Delivers a streamed plan the way a chunked transfer arrives: the head first,
 * then one `progress` event per chunk with `responseText` growing underneath it.
 *
 * Only a text response can be read while it is still arriving -- the spec keeps
 * `response` unavailable for json, blob and arraybuffer until DONE -- so those
 * types get the progress events in between and their body once, at the end.
 */
function streamMockedResponse(
  xhr: XMLHttpRequest,
  state: XhrState,
  plan: StreamPlan,
  onDelivered: (headers: Headers) => void,
): void {
  const headers = buildHeaders(plan.headers);
  const mimeType = headers.get('content-type') ?? '';
  const streamsText = xhr.responseType === '' || xhr.responseType === 'text';

  defineOwn(xhr, state, 'status', plan.status);
  defineOwn(xhr, state, 'statusText', plan.statusText);
  defineOwn(xhr, state, 'responseURL', state.url);
  installHeaderAccessors(xhr, state, headers);

  defineOwn(xhr, state, 'readyState', HEADERS_RECEIVED);
  dispatch(xhr, 'readystatechange');

  // A stream that never closes has to be logged when it opens, or it is never
  // logged at all -- the same reason a hung request is logged up front.
  if (plan.repeat === 0) onDelivered(headers);

  let text = '';
  let index = 0;
  let pass = 0;
  let stopped = false;

  // Measured from `send()`, like the platform's own timeout, and armed even for
  // an endless stream: a client timeout against a stream that never ends is
  // precisely the pairing this exists to reproduce.
  if (xhr.timeout > 0) {
    schedule(state, Math.max(0, state.startedAt + xhr.timeout - Date.now()), () => {
      if (stopped || state.aborted) return;
      stopped = true;
      state.reportTerminal?.('failed', null);
      finishWithFailure(xhr, state, 'timeout');
    });
  }

  const finish = () => {
    stopped = true;
    clearTimers(state);
    state.mockedBody = text;
    applyResponseBody(xhr, state, text, mimeType);

    const size = encoder.encode(text).byteLength;
    defineOwn(xhr, state, 'readyState', DONE);
    dispatch(xhr, 'readystatechange');
    dispatchProgress(xhr, 'load', size, size);
    dispatchProgress(xhr, 'loadend', size, size);
    onDelivered(headers);
  };

  const push = () => {
    if (stopped || state.aborted) return;

    text += plan.chunks[index] ?? '';
    if (streamsText) {
      defineOwn(xhr, state, 'responseText', text);
      defineOwn(xhr, state, 'response', text);
      // The spec only produces a document once the transfer is DONE, so there
      // is nothing to parse from a partial body yet.
      defineOwn(xhr, state, 'responseXML', null);
    }

    defineOwn(xhr, state, 'readyState', LOADING);
    dispatch(xhr, 'readystatechange');
    // `total` stays 0. A chunked body declares no length, so nothing about it
    // is computable, and saying otherwise would make a progress bar lie.
    dispatchProgress(xhr, 'progress', encoder.encode(text).byteLength, 0);

    index += 1;
    if (index >= plan.chunks.length) {
      index = 0;
      pass += 1;
      if (plan.repeat !== 0 && pass >= plan.repeat) {
        finish();
        return;
      }
    }
    schedule(state, plan.intervalMs, push);
  };

  if (plan.chunks.length === 0) {
    finish();
    return;
  }
  push();
}

/**
 * A mocked request never reaches the network, so the native `timeout` never
 * fires. Emulating it is what makes "does my client handle a slow server"
 * testable at all. Returns true when the timeout wins the race.
 */
function scheduleTimeoutIfEarlier(
  xhr: XMLHttpRequest,
  state: XhrState,
  responseAtMs: number,
): boolean {
  const timeout = xhr.timeout;
  if (timeout <= 0 || timeout >= responseAtMs) return false;
  schedule(state, timeout, () => {
    if (state.aborted) return;
    state.reportTerminal?.('failed', null);
    finishWithFailure(xhr, state, 'timeout');
  });
  return true;
}

/** Reports at most once, whichever terminal path gets there first. */
function createTerminalReporter(
  state: XhrState,
  rule: MockRule,
  report: Reporter,
): (outcome: TrafficOutcome, status: number | null, responseHeaders?: HeaderPair[]) => void {
  let reported = false;
  return (outcome, status, responseHeaders = []) => {
    if (reported) return;
    reported = true;
    report({
      url: state.url,
      method: state.method,
      transport: 'xhr',
      startedAt: state.startedAt,
      durationMs: Date.now() - state.startedAt,
      outcome,
      status,
      ruleId: rule.id,
      ruleName: rule.name,
      requestHeaders: tuplesToPairs(state.requestHeaders),
      requestBody: state.requestBody,
      requestBodyTruncated: state.requestBodyTruncated,
      responseHeaders,
      responseBody: outcome === 'mocked' ? state.mockedBody : null,
    });
  };
}

function runMockedLifecycle(
  xhr: XMLHttpRequest,
  state: XhrState,
  rule: MockRule,
  plan: SettledPlan,
  report: Reporter,
): void {
  if (plan.kind === 'passthrough') return;

  state.reportTerminal = createTerminalReporter(state, rule, report);

  if (state.isAsync) dispatchProgress(xhr, 'loadstart', 0, 0);

  if (plan.kind === 'networkError') {
    const hangs = plan.errorType === 'timeout';
    scheduleTimeoutIfEarlier(xhr, state, hangs ? Number.POSITIVE_INFINITY : plan.delayMs);

    // A hung request never terminates, so log it now rather than never.
    if (hangs) {
      state.reportTerminal('failed', null);
      return;
    }

    schedule(state, plan.delayMs, () => {
      if (state.aborted) return;
      state.reportTerminal?.('failed', null);
      finishWithFailure(xhr, state, 'error');
    });
    return;
  }

  if (plan.kind === 'stream') {
    // A synchronous request blocks the page until it is done, so no script can
    // observe a body arriving in pieces. It gets one pass of the chunks,
    // delivered whole -- which is what the platform would hand it anyway once
    // the transfer had finished.
    if (!state.isAsync) {
      const whole = plan.chunks.join('');
      state.mockedBody = whole;
      deliverMockedResponse(xhr, state, {
        kind: 'respond',
        status: plan.status,
        statusText: plan.statusText,
        headers: plan.headers,
        body: whole,
        delayMs: 0,
      });
      state.reportTerminal('mocked', plan.status, headersToPairs(buildHeaders(plan.headers)));
      return;
    }

    // Only covers a timeout that lands before the head does; once the stream is
    // running it arms its own deadline, so a timeout mid-stream still cuts off
    // a body that had already started arriving.
    if (scheduleTimeoutIfEarlier(xhr, state, plan.delayMs)) return;

    schedule(state, plan.delayMs, () => {
      if (state.aborted) return;
      streamMockedResponse(xhr, state, plan, (headers) => {
        state.reportTerminal?.('mocked', plan.status, headersToPairs(headers));
      });
    });
    return;
  }

  if (scheduleTimeoutIfEarlier(xhr, state, plan.delayMs)) return;

  const deliver = () => {
    if (state.aborted) return;
    state.mockedBody = plan.body;
    deliverMockedResponse(xhr, state, plan);
    state.reportTerminal?.('mocked', plan.status, headersToPairs(buildHeaders(plan.headers)));
  };

  if (!state.isAsync) {
    deliver();
    return;
  }

  // Always deferred, even at zero delay: handlers are routinely attached after
  // send() returns, and a synchronous delivery would never reach them.
  schedule(state, plan.delayMs, deliver);
}

/**
 * An XHR's response text is already in the page, so unlike `fetch` there is
 * nothing to clone and nothing to wait for. Reading it can still throw -- the
 * spec forbids `responseText` on a binary `responseType` -- and a `blob` or
 * `arraybuffer` response is not a mock source anyway.
 */
function readXhrText(xhr: XMLHttpRequest): { body: string | null; truncated: boolean } {
  try {
    const type = xhr.responseType;
    if (type !== '' && type !== 'text' && type !== 'json') return { body: null, truncated: false };
    const raw = type === 'json' ? JSON.stringify(xhr.response) : xhr.responseText;
    if (typeof raw !== 'string') return { body: null, truncated: false };
    return capBody(raw);
  } catch {
    return { body: null, truncated: false };
  }
}

function reportOnLoadEnd(
  xhr: XMLHttpRequest,
  state: XhrState,
  rule: MockRule | null,
  report: Reporter,
): void {
  xhr.addEventListener(
    'loadend',
    () => {
      const failed = xhr.status === 0;
      const captured = failed ? { body: null, truncated: false } : readXhrText(xhr);
      report({
        url: state.url,
        method: state.method,
        transport: 'xhr',
        startedAt: state.startedAt,
        durationMs: Date.now() - state.startedAt,
        outcome: failed ? 'failed' : 'passthrough',
        status: failed ? null : xhr.status,
        ruleId: rule?.id ?? null,
        ruleName: rule?.name ?? null,
        requestHeaders: tuplesToPairs(state.requestHeaders),
        requestBody: state.requestBody,
        requestBodyTruncated: state.requestBodyTruncated,
        // Empty on failure: there is no response to read headers from.
        responseHeaders: failed ? [] : parseRawHeaders(xhr.getAllResponseHeaders()),
        responseBody: captured.body,
        responseBodyTruncated: captured.truncated,
      });
    },
    { once: true },
  );
}

/* -------------------------------------------------------------------------- */
/* Installation                                                               */
/* -------------------------------------------------------------------------- */

export function installXhrPatch(context: XhrPatchContext): void {
  if (typeof XMLHttpRequest !== 'function') return;

  const proto = XMLHttpRequest.prototype;
  /*
   * Capturing the prototype methods unbound is exactly what a patch has to do:
   * every one of them is called back with `.call(this)` or `.apply(this)` on
   * the instance it came from.
   */
  /* eslint-disable @typescript-eslint/unbound-method */
  const nativeOpen = proto.open;
  const nativeSend = proto.send;
  const nativeAbort = proto.abort;
  const nativeSetRequestHeader = proto.setRequestHeader;
  /* eslint-enable @typescript-eslint/unbound-method */

  // `open` is overloaded (2-arg and 5-arg). Taking a loose tuple and forwarding
  // it verbatim keeps the platform's own defaulting for `async` intact.
  type OpenArgs = [
    method: string,
    url: string | URL,
    isAsync?: boolean,
    username?: string | null,
    password?: string | null,
  ];

  proto.open = function open(this: XMLHttpRequest, ...args: OpenArgs): void {
    const [method, url, isAsync] = args;
    const previous = states.get(this);
    if (previous) {
      clearTimers(previous);
      restoreInstance(this, previous);
    }

    states.set(this, {
      method: String(method).toUpperCase(),
      url: absolutizeUrl(String(url)),
      isAsync: isAsync !== false,
      requestHeaders: [],
      requestBody: null,
      requestBodyTruncated: false,
      startedAt: 0,
      mocked: false,
      aborted: false,
      timers: new Set(),
      shadowed: new Set(),
      mockedBody: null,
      reportTerminal: null,
    });

    nativeOpen.apply(this, args as Parameters<typeof nativeOpen>);
  };

  proto.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    states.get(this)?.requestHeaders.push([name, value]);
    nativeSetRequestHeader.call(this, name, value);
  };

  proto.send = function send(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = states.get(this);
    if (!state) {
      nativeSend.call(this, body ?? null);
      return;
    }

    state.startedAt = Date.now();
    /*
     * `send()` starts a fresh request lifecycle, so a latched abort from before
     * it must not survive into it. The platform allows `abort()` on an opened
     * request that was never sent -- it is a no-op there -- and a flag left
     * standing would silently swallow every event of the send that follows,
     * wedging the instance for good.
     */
    state.aborted = false;

    const buildFacts = (): RequestFacts => {
      // Rebuilt at decision time: headers can still be set between `open()`
      // and `send()`, and a deferred decision must see the final set.
      const collected = assembleRequest(
        state.url,
        state.method,
        tuplesToPairs(state.requestHeaders),
        collectXhrBody(body),
      );
      state.requestBody = collected.requestBody;
      state.requestBodyTruncated = collected.requestBodyTruncated;
      return collected.facts;
    };

    const deliver = (rule: MockRule, plan: SettledPlan) => {
      if (state.aborted) return;
      if (plan.kind === 'passthrough') {
        reportOnLoadEnd(this, state, rule, context.report);
        nativeSend.call(this, body ?? null);
        return;
      }
      state.mocked = true;
      runMockedLifecycle(this, state, rule, plan, context.report);
    };

    const decideAndRun = () => {
      if (state.aborted) return;
      const config = context.gate.snapshot();
      const facts = buildFacts();
      const found = config === null ? null : decideRequest(config, facts);

      if (found === null || config === null) {
        reportOnLoadEnd(this, state, null, context.report);
        nativeSend.call(this, body ?? null);
        return;
      }

      if (found.plan.kind !== 'handler') {
        deliver(found.rule, found.plan);
        return;
      }

      /*
       * A handler has to run before there is an answer, and running it means
       * waiting for another frame to reply. A synchronous request cannot wait
       * for anything -- `send()` must have the whole response by the time it
       * returns -- so it gets the same visible 500 a crashed handler would,
       * naming the reason. Passing it through instead would look like the rule
       * had simply not matched.
       */
      if (!state.isAsync) {
        state.mocked = true;
        runMockedLifecycle(
          this,
          state,
          found.rule,
          unrunnableHandler(
            'A handler cannot answer a synchronous XMLHttpRequest: the code has to run before the response exists, and send() cannot wait. Use an asynchronous request, or a Respond rule.',
          ),
          context.report,
        );
        return;
      }

      // Asynchronous: `send()` returns now and the response arrives through
      // events later, which is exactly the shape a handler needs.
      void settleDecision({
        config,
        facts,
        decision: found,
        client: context.handlers,
        transport: 'xhr',
        startedAt: state.startedAt,
      }).then(
        (settled) => {
          if (state.aborted) return;
          if (settled === null) {
            reportOnLoadEnd(this, state, found.rule, context.report);
            nativeSend.call(this, body ?? null);
            return;
          }
          deliver(settled.rule, settled.plan);
        },
        (error: unknown) => {
          if (state.aborted) return;
          state.mocked = true;
          runMockedLifecycle(
            this,
            state,
            found.rule,
            unrunnableHandler(String(error)),
            context.report,
          );
        },
      );
    };

    // A synchronous request cannot wait for anything, so it decides with
    // whatever config is already known.
    if (!state.isAsync || context.gate.isReady) {
      decideAndRun();
      return;
    }
    void context.gate.waitUntilReady().then(decideAndRun);
  };

  proto.abort = function abort(this: XMLHttpRequest): void {
    const state = states.get(this);
    if (!state) {
      nativeAbort.call(this);
      return;
    }

    state.aborted = true;
    clearTimers(state);

    if (!state.mocked) {
      nativeAbort.call(this);
      return;
    }

    state.reportTerminal?.('failed', null);

    if (this.readyState !== UNSENT && this.readyState !== DONE) {
      finishWithFailure(this, state, 'abort');
    }
    // The spec drops back to UNSENT after the abort events, without notifying.
    defineOwn(this, state, 'readyState', UNSENT);
  };
}
