import {
  HANDLER_CHANNEL,
  createId,
  isHandlerReplyMessage,
  type HandlerCallMessage,
  type HandlerOutcome,
  type HandlerRequest,
} from '@mocksmith/core';

/**
 * The page's side of the handler sandbox.
 *
 * It owns one hidden iframe pointing at the extension's sandbox page, sends
 * calls into it, and matches replies back to the request that is waiting. Two
 * postMessages and no service worker: the frame is in this page's own process,
 * so a handler costs about as much as a promise.
 *
 * Three things here are load-bearing and none are obvious:
 *
 *  1. **Replies are only trusted from the frame.** Every message posted to the
 *     page is visible to the site, and a site could post a forged `result` and
 *     choose what its own mocked response says. `event.source` cannot be
 *     spoofed, so it is the check that matters.
 *  2. **The timeout lives here, not in the sandbox.** A handler stuck in
 *     `while (true)` wedges the sandbox frame permanently: no timer inside it
 *     will ever run again. Only this side can still count.
 *  3. **A wedged frame is replaced.** Otherwise one bad handler would take
 *     every later handler down with it, and the only way back would be a page
 *     reload.
 */

export interface HandlerCall {
  ruleId: string;
  ruleName: string;
  code: string;
  request: HandlerRequest;
  timeoutMs: number;
}

export interface HandlerSuccess {
  ok: true;
  outcome: HandlerOutcome;
}

export interface HandlerFailure {
  ok: false;
  /** One sentence, already fit to show in the traffic log. */
  message: string;
}

export type HandlerCallResult = HandlerSuccess | HandlerFailure;

export interface HandlerClient {
  /** Tells the client where the sandbox lives. Called when config arrives. */
  setSandboxUrl(url: string | undefined): void;
  /** True when a sandbox can be reached at all, so callers can say why not. */
  readonly available: boolean;
  run(call: HandlerCall): Promise<HandlerCallResult>;
}

interface Pending {
  resolve: (result: HandlerCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
  ruleName: string;
}

/** Long enough for a frame to load on a cold page, short enough to give up on. */
const FRAME_READY_TIMEOUT_MS = 4000;

export function createHandlerClient(): HandlerClient {
  let sandboxUrl: string | undefined;
  let frame: HTMLIFrameElement | null = null;
  let ready: Promise<boolean> | null = null;
  const pending = new Map<string, Pending>();

  const settle = (id: string, result: HandlerCallResult): void => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(result);
  };

  /**
   * Tears the frame down and forgets it. Everything still waiting is answered
   * first: a pending promise that never settles would leave the page's own
   * `fetch` hanging, which is a worse bug than the one being recovered from.
   */
  const discardFrame = (reason: string): void => {
    for (const id of [...pending.keys()]) settle(id, { ok: false, message: reason });
    try {
      frame?.remove();
    } catch {
      // The document may already be tearing down.
    }
    frame = null;
    ready = null;
  };

  window.addEventListener('message', (event: MessageEvent) => {
    // Only the sandbox frame is believed. Anything else with this channel on it
    // is the page pretending, and a page choosing its own mock responses would
    // make every rule in the list a suggestion.
    if (frame === null || event.source !== frame.contentWindow) return;
    if (!isHandlerReplyMessage(event.data)) return;
    const message = event.data;

    if (message.kind === 'result') {
      settle(message.id, { ok: true, outcome: message.outcome });
      return;
    }
    if (message.kind === 'error') {
      settle(message.id, { ok: false, message: message.message });
      return;
    }
    if (message.kind === 'log') {
      const name = pending.get(message.id)?.ruleName ?? 'handler';
      // The page's console, not the frame's: that is where the person
      // debugging their own page is already looking.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called immediately below
      const write = console[message.level] as ((...args: unknown[]) => void) | undefined;
      (write ?? console.log)(`[decoy ${name}]`, message.text);
    }
  });

  const mountFrame = (url: string): Promise<boolean> => {
    const element = document.createElement('iframe');
    element.src = url;
    // Out of the way of the page in every sense: no size, no space taken, not
    // announced, not focusable, and never a scroll anchor.
    element.setAttribute('aria-hidden', 'true');
    element.setAttribute('tabindex', '-1');
    element.style.cssText =
      'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px;top:-9999px';
    frame = element;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const onMessage = (event: MessageEvent) => {
        if (event.source !== element.contentWindow) return;
        if (!isHandlerReplyMessage(event.data) || event.data.kind !== 'ready') return;
        window.removeEventListener('message', onMessage);
        done(true);
      };
      window.addEventListener('message', onMessage);
      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        done(false);
      }, FRAME_READY_TIMEOUT_MS);

      const attach = () => {
        const parent = document.body ?? document.documentElement;
        if (parent === null) {
          done(false);
          return;
        }
        parent.append(element);
      };
      // A handler can fire at document_start, before there is anywhere to put
      // the frame.
      if (document.body === null) {
        document.addEventListener('DOMContentLoaded', attach, { once: true });
      } else {
        attach();
      }
    });
  };

  const ensureFrame = (): Promise<boolean> => {
    if (sandboxUrl === undefined) return Promise.resolve(false);
    ready ??= mountFrame(sandboxUrl);
    return ready;
  };

  return {
    setSandboxUrl: (url) => {
      if (url === sandboxUrl) return;
      sandboxUrl = url;
      // A changed url means the extension was reloaded and the old frame points
      // at a dead origin.
      discardFrame('The extension reloaded while the handler was running.');
    },
    get available() {
      return sandboxUrl !== undefined;
    },
    run: async (call) => {
      if (sandboxUrl === undefined) {
        return {
          ok: false,
          message: 'The handler sandbox is not available on this page.',
        };
      }

      const mounted = await ensureFrame();
      const target = frame?.contentWindow ?? null;
      if (!mounted || target === null) {
        return { ok: false, message: 'The handler sandbox did not start.' };
      }

      const id = createId('call');
      const message: HandlerCallMessage = {
        channel: HANDLER_CHANNEL,
        kind: 'call',
        id,
        ruleId: call.ruleId,
        code: call.code,
        request: call.request,
        timeoutMs: call.timeoutMs,
      };

      return await new Promise<HandlerCallResult>((resolve) => {
        const timer = setTimeout(() => {
          // Nothing came back in time. The frame may be permanently wedged --
          // a synchronous infinite loop cannot be interrupted from inside --
          // so it is thrown away and the next call gets a fresh one.
          discardFrame(
            `The handler did not answer within ${String(call.timeoutMs)}ms and was stopped.`,
          );
        }, call.timeoutMs + 250);

        pending.set(id, { resolve, timer, ruleName: call.ruleName });

        try {
          target.postMessage(message, '*');
        } catch (error) {
          settle(id, {
            ok: false,
            message: `The request could not be sent to the handler: ${String(error)}`,
          });
        }
      });
    },
  };
}
