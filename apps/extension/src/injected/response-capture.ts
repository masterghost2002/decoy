import { MAX_CAPTURED_BODY } from '@decoy/core';

/**
 * Reading the body of a real response, so "Mock this" can prefill a rule with
 * what the endpoint actually returned rather than an empty `{}`.
 *
 * Three constraints shape all of this:
 *
 *  - It must not add latency to the page's own `fetch`. So the body is read from
 *    a clone, the read is never awaited on the request path, and the result is
 *    reported as a follow-up keyed to the entry id.
 *  - It must not change what the page sees. `clone()` tees the stream; the app's
 *    branch is untouched, and failing to clone is not an error worth raising.
 *  - It must not buffer a download. Only textual content types are read, and
 *    the read stops at the same cap request payloads use.
 */

/** Content types worth reading. Anything else is a download, not a mock source. */
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded|.*\+json))/i;

export interface CapturedBody {
  body: string | null;
  truncated: boolean;
}

function isTextual(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  // An absent content type is usually a small text payload, so it is read.
  if (contentType === null || contentType.length === 0) return true;
  return TEXTUAL.test(contentType.trim());
}

/**
 * Reads at most `MAX_CAPTURED_BODY` bytes and then cancels, so a streamed
 * response cannot grow the tee buffer without bound. Cancelling our branch
 * leaves the page's branch alone.
 */
async function readCapped(response: Response): Promise<CapturedBody> {
  const stream = response.body;
  if (stream === null) return { body: '', truncated: false };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_CAPTURED_BODY) {
        truncated = true;
        text = text.slice(0, MAX_CAPTURED_BODY);
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    // Releases the tee branch whether we finished or bailed out early.
    void reader.cancel().catch(() => undefined);
  }

  return { body: text, truncated };
}

/**
 * Clones `response` and resolves with its body, or with `null` when the body is
 * not something worth capturing. Never rejects, and never touches the response
 * the caller is about to return.
 */
export function captureResponseBody(response: Response): Promise<CapturedBody> {
  const nothing: CapturedBody = { body: null, truncated: false };

  // An opaque `no-cors` response has no readable body by design, and a consumed
  // one cannot be cloned.
  if (response.type === 'opaque' || response.bodyUsed) return Promise.resolve(nothing);
  if (!isTextual(response)) return Promise.resolve(nothing);

  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return Promise.resolve(nothing);
  }

  return readCapped(clone).catch(() => nothing);
}
