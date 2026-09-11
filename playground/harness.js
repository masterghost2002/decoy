/**
 * The playground harness: a registry, a runner, and the assertions the cases
 * are written with.
 *
 * Three properties are deliberate, because they are what makes the difference
 * between a page of buttons and something you can trust:
 *
 *  1. **Every case is independent and re-runnable.** Anything stateful -- a
 *     handler's `store`, a cookie, a counter -- is keyed by `nonce()` or
 *     cleaned up, so clicking a case twice gives the same answer and so does
 *     running the whole list in any order.
 *  2. **A missing rule skips, it does not fail.** The page reads the live
 *     config off the bridge, so a case whose rule was never seeded says
 *     "not seeded" rather than "broken", and a red row always means a real
 *     regression.
 *  3. **One definition of working.** `window.__decoy.runAll()` is what the
 *     button calls and what `pnpm e2e` calls, and the result shape is the same
 *     either way.
 */
import { PAGE_BRIDGE_CHANNEL } from './bridge-channel.js';

/* -------------------------------------------------------------------------- */
/* Live config, read off the bridge                                           */
/*                                                                            */
/* The isolated content script posts the whole config into the page on every   */
/* change. That is documented, and it is what lets the harness know whether    */
/* the extension is even installed.                                           */
/* -------------------------------------------------------------------------- */

const state = {
  config: null,
  receivedAt: null,
  sandboxUrl: null,
  listeners: new Set(),
};

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  if (data.channel !== PAGE_BRIDGE_CHANNEL) return;
  if (data.direction !== 'to-page' || data.kind !== 'config') return;

  state.config = data.config ?? null;
  state.sandboxUrl = data.sandboxUrl ?? null;
  state.receivedAt = Date.now();
  for (const listener of state.listeners) listener(liveStatus());
});

// The bridge replays the config on request, so a page that loaded before the
// worker woke up is not stuck waiting for the next change.
function announceReady() {
  window.postMessage({ channel: PAGE_BRIDGE_CHANNEL, direction: 'from-page', kind: 'ready' }, '*');
}
announceReady();
// Once more after load, for the case where the content script is still booting.
window.addEventListener('load', announceReady);

export function onLiveStatus(listener) {
  state.listeners.add(listener);
  listener(liveStatus());
  return () => state.listeners.delete(listener);
}

export function liveStatus() {
  const config = state.config;
  const seeded = new Set((config?.rules ?? []).map((rule) => rule.id));
  return {
    detected: config !== null,
    enabled: config?.enabled ?? false,
    ruleCount: (config?.rules ?? []).length,
    seeded,
    sandboxUrl: state.sandboxUrl,
    receivedAt: state.receivedAt,
    config,
  };
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

export function assertDeep(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`);
}

export function assertMatch(actual, pattern, label) {
  if (typeof actual !== 'string' || !pattern.test(actual)) {
    throw new Error(`${label}: ${show(actual)} does not match ${String(pattern)}`);
  }
}

export function assertIncludes(actual, needle, label) {
  if (typeof actual !== 'string' || !actual.includes(needle)) {
    throw new Error(`${label}: ${show(actual)} does not contain ${show(needle)}`);
  }
}

/** A lower bound with no upper one: a loaded machine is allowed to be slow. */
export function assertAtLeast(actual, floor, label) {
  if (!(actual >= floor))
    throw new Error(`${label}: expected at least ${String(floor)}, got ${String(actual)}`);
}

export function assertAtMost(actual, ceiling, label) {
  if (!(actual <= ceiling))
    throw new Error(`${label}: expected at most ${String(ceiling)}, got ${String(actual)}`);
}

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** The error a promise rejected with, or a failure if it resolved instead. */
export async function expectRejection(promise, label) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`${label}: expected a rejection, but it resolved`);
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Unique per call, so a stateful case can be run again without resetting it. */
let counter = 0;
export function nonce(prefix = 'n') {
  counter += 1;
  return `${prefix}${String(Date.now() % 1e7)}x${String(counter)}`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const now = () => performance.now();

/** Resolves with the first of these events to fire, plus a snapshot of the xhr. */
export function waitForXhr(xhr, events = ['load', 'error', 'timeout', 'abort']) {
  return new Promise((resolve) => {
    for (const type of events) {
      xhr.addEventListener(
        type,
        () => {
          resolve({ event: type, status: xhr.status, readyState: xhr.readyState });
        },
        { once: true },
      );
    }
  });
}

/** open + send + wait, for the many cases that only need the settled state. */
export async function xhrRequest(method, url, options = {}) {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url, options.async ?? true);
  if (options.responseType !== undefined) xhr.responseType = options.responseType;
  if (options.timeout !== undefined) xhr.timeout = options.timeout;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    xhr.setRequestHeader(name, value);
  }
  const settled = waitForXhr(xhr);
  xhr.send(options.body ?? null);
  return { xhr, settled: await settled };
}

/** Reads a whole ReadableStream, reporting how many reads it took. */
export async function drain(response) {
  assert(response.body !== null, 'response.body should be a ReadableStream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pieces = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pieces.push(decoder.decode(value, { stream: true }));
  }
  return { pieces, text: pieces.join('') };
}

/** Sets a cookie, and gives back the undo so a case cannot leak into the next. */
export function setCookie(name, value) {
  document.cookie = `${name}=${value};path=/`;
  return () => {
    document.cookie = `${name}=;path=/;max-age=0`;
  };
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A case that never settles must not be able to take the run down with it.
 * Every one here answers in well under a second except the deliberately slow
 * ones, so this is a backstop rather than a budget.
 */
export const DEFAULT_CASE_TIMEOUT_MS = 15_000;

/** @type {Array<{id: string, title: string, blurb: string, cases: Array}>} */
export const suites = [];

export function suite(id, title, blurb) {
  const entry = { id, title, blurb, cases: [] };
  suites.push(entry);

  /**
   * @param {string} name   what the case claims, in one line
   * @param {object} spec   { rules, doc, run, slow }
   */
  return function add(name, spec) {
    entry.cases.push({
      id: `${id}/${entry.cases.length + 1}`,
      suite: id,
      name: `${id}: ${name}`,
      shortName: name,
      rules: spec.rules ?? [],
      doc: spec.doc ?? '',
      slow: spec.slow ?? false,
      timeoutMs: spec.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
      run: spec.run,
    });
  };
}

export function allCases() {
  return suites.flatMap((entry) => entry.cases);
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                 */
/* -------------------------------------------------------------------------- */

function skipReason(testCase, live) {
  if (testCase.rules.length === 0) return null;
  if (!live.detected)
    return 'Decoy has not pushed a config to this page — is the extension loaded?';
  if (!live.enabled) return 'mocking is paused by the master switch';
  const missing = testCase.rules.filter((id) => !live.seeded.has(id));
  if (missing.length === 0) return null;
  return `rule${missing.length === 1 ? '' : 's'} not seeded: ${missing.join(', ')}`;
}

export async function runCase(testCase) {
  const live = liveStatus();
  const skip = skipReason(testCase, live);
  if (skip !== null) {
    return {
      name: testCase.name,
      id: testCase.id,
      suite: testCase.suite,
      status: 'skip',
      ok: false,
      detail: skip,
      ms: 0,
    };
  }

  const startedAt = performance.now();
  let watchdog;
  try {
    const detail = await Promise.race([
      testCase.run(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          reject(new Error(`the case did not settle within ${String(testCase.timeoutMs)}ms`));
        }, testCase.timeoutMs);
      }),
    ]);
    return {
      name: testCase.name,
      id: testCase.id,
      suite: testCase.suite,
      status: 'pass',
      ok: true,
      detail: typeof detail === 'string' ? detail : 'ok',
      ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      name: testCase.name,
      id: testCase.id,
      suite: testCase.suite,
      status: 'fail',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Runs cases one at a time, on purpose: several of them assert on timing, and
 * a dozen concurrent streams on one event loop would make those readings
 * meaningless.
 *
 * @param {{
 *   only?: (testCase: object) => boolean,
 *   onStart?: (testCase: object) => void,
 *   onResult?: (result: object) => void,
 * }} options
 */
export async function runAll(options = {}) {
  const results = [];
  for (const testCase of allCases()) {
    if (options.only !== undefined && !options.only(testCase)) continue;
    options.onStart?.(testCase);
    const result = await runCase(testCase);
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}

export function summarize(results) {
  return {
    total: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skip').length,
    ms: results.reduce((total, result) => total + result.ms, 0),
  };
}
