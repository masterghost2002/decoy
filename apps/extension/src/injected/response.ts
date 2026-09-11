import type { RespondPlan, StreamPlan } from '@mocksmith/core';

import { abortReason } from './timing.js';

/** The Fetch spec only allows constructing a Response in this status range. */
const MIN_CONSTRUCTIBLE_STATUS = 200;
const MAX_CONSTRUCTIBLE_STATUS = 599;

export function buildHeaders(pairs: ReadonlyArray<[string, string]>): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    try {
      headers.append(name, value);
    } catch {
      // One malformed header name must not sink the whole mock.
    }
  }
  return headers;
}

function clampStatus(status: number): number {
  if (status < MIN_CONSTRUCTIBLE_STATUS) return MIN_CONSTRUCTIBLE_STATUS;
  if (status > MAX_CONSTRUCTIBLE_STATUS) return MAX_CONSTRUCTIBLE_STATUS;
  return status;
}

export function buildMockResponse(plan: RespondPlan, url: string): Response {
  const status = clampStatus(plan.status);
  const headers = buildHeaders(plan.headers);

  let response: Response;
  try {
    response = new Response(plan.body, { status, statusText: plan.statusText, headers });
  } catch {
    // A reason phrase with illegal characters is the only likely cause here.
    response = new Response(plan.body, { status, headers });
  }

  // A constructed Response has an empty `url`. Application code reads it for
  // redirect checks and error reporting, so it should see the request url.
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
  } catch {
    // Non-fatal: the response is still usable without it.
  }

  return response;
}

/**
 * The body of a streamed plan, as a real `ReadableStream` the page can consume
 * with a reader or with `Response.body.pipeThrough`.
 *
 * The first chunk is enqueued as the stream starts -- the head delay has
 * already been served by the time this is built -- and the rest follow one per
 * `intervalMs`. A plan with `repeat: 0` never closes, which is the point: an
 * event source that ends on its own is not the thing being mocked.
 */
function createChunkStream(
  plan: StreamPlan,
  signal: AbortSignal | null,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachAbort: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    detachAbort?.();
    detachAbort = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      let pass = 0;

      const abort = () => {
        if (stopped) return;
        stop();
        try {
          controller.error(abortReason(signal));
        } catch {
          // The reader is already gone; there is nobody left to tell.
        }
      };

      if (signal !== null) {
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        detachAbort = () => {
          signal.removeEventListener('abort', abort);
        };
      }

      const push = () => {
        if (stopped) return;
        controller.enqueue(encoder.encode(plan.chunks[index] ?? ''));

        index += 1;
        if (index >= plan.chunks.length) {
          index = 0;
          pass += 1;
          if (plan.repeat !== 0 && pass >= plan.repeat) {
            stop();
            controller.close();
            return;
          }
        }
        timer = setTimeout(push, plan.intervalMs);
      };

      push();
    },
    cancel() {
      // The page stopped reading -- close the loop rather than keep timers
      // alive for a stream nobody is listening to.
      stop();
    },
  });
}

export function buildStreamResponse(
  plan: StreamPlan,
  url: string,
  signal: AbortSignal | null,
): Response {
  const status = clampStatus(plan.status);
  const headers = buildHeaders(plan.headers);
  // No chunks means no body at all, rather than a stream that opens and
  // immediately closes -- the two are indistinguishable to a reader, and the
  // first one is what a status like 204 actually requires.
  const body = plan.chunks.length === 0 ? null : createChunkStream(plan, signal);

  let response: Response;
  try {
    response = new Response(body, { status, statusText: plan.statusText, headers });
  } catch {
    response = new Response(body, { status, headers });
  }

  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
  } catch {
    // Non-fatal: the response is still usable without it.
  }

  return response;
}
