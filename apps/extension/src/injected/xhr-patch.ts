import {
  decideRequest,
  type MockPlan,
  type MockRule,
  type RespondPlan,
  type TrafficOutcome,
} from '@mocksmith/core';

import type { ConfigGate } from './config-gate.js';
import type { Reporter } from './reporter.js';
import { buildHeaders } from './response.js';
import { absolutizeUrl } from './url.js';

export interface XhrPatchContext {
  gate: ConfigGate;
  report: Reporter;
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
  startedAt: number;
  /** True once we have decided to answer this request ourselves. */
  mocked: boolean;
  aborted: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** Instance properties we defined, so a reused instance can be restored. */
  shadowed: Set<string>;
  /**
   * Set once a rule takes the request over. Every way the request can end --
   * delivered, failed, client timeout, aborted -- funnels through this, so a
   * request that never completed still shows up in the traffic log. That is
   * precisely the case someone is debugging.
   */
  reportTerminal: ((outcome: TrafficOutcome, status: number | null) => void) | null;
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
    const parsed = new DOMParser().parseFromString(text, type as DOMParserSupportedType);
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
      let parsed: unknown = null;
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
): (outcome: TrafficOutcome, status: number | null) => void {
  let reported = false;
  return (outcome, status) => {
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
    });
  };
}

function runMockedLifecycle(
  xhr: XMLHttpRequest,
  state: XhrState,
  rule: MockRule,
  plan: MockPlan,
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

  if (scheduleTimeoutIfEarlier(xhr, state, plan.delayMs)) return;

  const deliver = () => {
    if (state.aborted) return;
    deliverMockedResponse(xhr, state, plan);
    state.reportTerminal?.('mocked', plan.status);
  };

  if (!state.isAsync) {
    deliver();
    return;
  }

  // Always deferred, even at zero delay: handlers are routinely attached after
  // send() returns, and a synchronous delivery would never reach them.
  schedule(state, plan.delayMs, deliver);
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
  const nativeOpen = proto.open;
  const nativeSend = proto.send;
  const nativeAbort = proto.abort;
  const nativeSetRequestHeader = proto.setRequestHeader;

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
      startedAt: 0,
      mocked: false,
      aborted: false,
      timers: new Set(),
      shadowed: new Set(),
      reportTerminal: null,
    });

    (nativeOpen as (...rest: OpenArgs) => void).apply(this, args);
  } as XMLHttpRequest['open'];

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

    const decideAndRun = () => {
      if (state.aborted) return;
      const config = context.gate.snapshot();
      const decision =
        config === null ? null : decideRequest(config, { url: state.url, method: state.method });

      if (decision === null || decision.plan.kind === 'passthrough') {
        reportOnLoadEnd(this, state, decision?.rule ?? null, context.report);
        nativeSend.call(this, body ?? null);
        return;
      }

      state.mocked = true;
      runMockedLifecycle(this, state, decision.rule, decision.plan, context.report);
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
