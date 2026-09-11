/**
 * The sandbox: the only place in Mocksmith where a string becomes a function.
 *
 * This page is listed under `sandbox.pages` in the manifest, which gives it a
 * policy that permits `eval` and denies it every `chrome.*` API. That trade is
 * exactly the one we want. It is measurably the only context available:
 *
 *   - the page's own world       -- `new Function` throws under any site CSP
 *                                   without `unsafe-eval`, which is every
 *                                   hardened app
 *   - an isolated content script -- throws, MV3's extension policy
 *   - the service worker         -- throws, MV3's extension policy
 *   - a sandboxed extension page -- runs, and a site's `frame-src` does not
 *                                   apply to it
 *
 * It holds no state that matters except the compiled-handler cache and each
 * rule's `store`, both of which are per page load by design.
 *
 * Nothing here trusts its input: the code is the user's, so it is expected to
 * throw, loop, and return nonsense, and every one of those has to come back as
 * an answer rather than as a wedged page.
 */
import {
  HANDLER_CHANNEL,
  isHandlerCallMessage,
  type HandlerCallMessage,
  type HandlerErrorMessage,
  type HandlerLogMessage,
  type HandlerOutcome,
  type HandlerReadyMessage,
  type HandlerResultMessage,
} from '@mocksmith/core';

import { compileHandler, describe, formatLogArgument, type CompiledHandler } from './compile.js';
import { createResponder } from './responder.js';

/** Compiled once per distinct source, not once per request. */
const compiled = new Map<string, CompiledHandler>();
/** One `store` per rule, surviving between requests for the life of the page. */
const stores = new Map<string, Record<string, unknown>>();

const LOG_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function post(message: HandlerResultMessage | HandlerErrorMessage | HandlerLogMessage): void {
  parent.postMessage(message, '*');
}

function fail(id: string, message: string, compileError: boolean): void {
  post({ channel: HANDLER_CHANNEL, kind: 'error', id, message, compileError });
}

/**
 * A `console` that reaches the person debugging. The sandbox frame has its own
 * console, in a DevTools context nobody has selected; these go back to the page
 * and are printed there.
 */
function createLogger(id: string): Record<LogLevel, (...args: unknown[]) => void> {
  const logger = {} as Record<LogLevel, (...args: unknown[]) => void>;
  for (const level of LOG_LEVELS) {
    logger[level] = (...args: unknown[]) => {
      post({
        channel: HANDLER_CHANNEL,
        kind: 'log',
        id,
        level,
        text: args.map(formatLogArgument).join(' '),
      });
    };
  }
  return logger;
}

/**
 * Guards a handler that awaits something that never settles. A handler stuck in
 * a synchronous loop cannot be caught here at all -- no timer in this frame
 * will ever run again -- which is why the page side times out independently and
 * replaces this frame when it does.
 */
function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The handler did not finish within ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(describe(error)));
      },
    );
  });
}

async function handle(call: HandlerCallMessage): Promise<void> {
  let run = compiled.get(call.code);
  if (run === undefined) {
    const result = compileHandler(call.code);
    if (!result.ok) {
      fail(call.id, result.message, true);
      return;
    }
    run = result.run;
    // Keyed by source, so editing a handler recompiles and an unchanged one
    // never does. Bounded, because a page that reloads a rule in a loop should
    // not grow this forever.
    if (compiled.size > 64) compiled.clear();
    compiled.set(call.code, run);
  }

  const store = stores.get(call.ruleId) ?? {};
  stores.set(call.ruleId, store);

  const handle = createResponder();

  let outcome: HandlerOutcome;
  try {
    const returned: unknown = await withTimeout(
      Promise.resolve(
        run(call.request, handle.res, handle.next, store, createLogger(call.id)),
      ),
      call.timeoutMs,
    );
    outcome = handle.resolve(returned);
  } catch (error) {
    fail(call.id, describe(error), false);
    return;
  }

  try {
    post({ channel: HANDLER_CHANNEL, kind: 'result', id: call.id, outcome });
  } catch {
    // The outcome held something that cannot cross a postMessage boundary --
    // a function or a DOM node in a header value, say. Say so, rather than
    // leaving the request pending until the page times it out.
    fail(call.id, 'The handler answered with something that cannot be sent back.', false);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!isHandlerCallMessage(event.data)) return;
  void handle(event.data);
});

const ready: HandlerReadyMessage = { channel: HANDLER_CHANNEL, kind: 'ready' };
parent.postMessage(ready, '*');
