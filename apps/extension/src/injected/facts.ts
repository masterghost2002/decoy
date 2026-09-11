/**
 * Everything the page can tell us about a request, gathered without disturbing
 * it. Two rules govern this file:
 *
 *  1. Never consume a body the caller still needs. Streams are left alone and
 *     `Request` objects are cloned.
 *  2. Never throw. A fact we cannot read is simply absent, and an absent fact
 *     makes a condition fail to match rather than breaking the request.
 */
import {
  capBody,
  headerPairsToRecord,
  parseCookieString,
  type HeaderPair,
  type RequestFacts,
} from '@mocksmith/core';

import { isRequestObject } from './url.js';

const decoder = new TextDecoder();

export function readCookies(): Record<string, string> {
  try {
    return typeof document === 'undefined' ? {} : parseCookieString(document.cookie);
  } catch {
    // A sandboxed document throws on `cookie` access.
    return {};
  }
}

export function headersToPairs(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  try {
    headers.forEach((value, name) => {
      pairs.push({ name, value });
    });
  } catch {
    // Nothing useful to add if the platform refuses to enumerate.
  }
  return pairs;
}

export function tuplesToPairs(tuples: Array<[string, string]>): HeaderPair[] {
  return tuples.map(([name, value]) => ({ name, value }));
}

/** `getAllResponseHeaders()` returns one CRLF-separated `name: value` per line. */
export function parseRawHeaders(raw: string): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    if (name.length === 0) continue;
    pairs.push({ name, value: line.slice(separator + 1).trim() });
  }
  return pairs;
}

/* -------------------------------------------------------------------------- */
/* Request headers                                                            */
/* -------------------------------------------------------------------------- */

export function collectFetchHeaders(input: RequestInfo | URL, init?: RequestInit): HeaderPair[] {
  const source = init?.headers ?? (isRequestObject(input) ? input.headers : undefined);
  if (source === undefined) return [];

  try {
    // `new Headers(...)` normalizes every accepted shape: Headers, record, and
    // array-of-tuples alike.
    return headersToPairs(new Headers(source));
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

function formDataToText(form: FormData): string {
  const parts: string[] = [];
  form.forEach((value, key) => {
    // A File has no useful text form; name it rather than inlining bytes.
    parts.push(`${key}=${typeof value === 'string' ? value : `[file ${value.name}]`}`);
  });
  return parts.join('&');
}

/**
 * Serializes a request body for matching and for the traffic drawer. Returns
 * null when there is no body, or when reading one would consume a stream the
 * request still needs.
 */
async function readBodyInit(body: unknown): Promise<string | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;

  try {
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.toString();
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return formDataToText(body);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return await body.text();
    }
    if (body instanceof ArrayBuffer) {
      return decoder.decode(new Uint8Array(body));
    }
    if (ArrayBuffer.isView(body)) {
      return decoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }
  } catch {
    return null;
  }

  // A ReadableStream is deliberately not read: consuming it would break the
  // very request we are trying to observe.
  return null;
}

export async function collectFetchBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | null> {
  if (init && 'body' in init) return readBodyInit(init.body);

  if (isRequestObject(input)) {
    if (input.bodyUsed) return null;
    try {
      // The clone tees the stream, so the original stays readable.
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * XHR's `send()` is synchronous and a synchronous XHR cannot await anything, so
 * this path stays sync. Only a `Blob` payload needs async reading, and it is
 * reported as absent -- a condition on binary upload bytes is not meaningful
 * anyway.
 */
export function collectXhrBody(
  body: Document | XMLHttpRequestBodyInit | null | undefined,
): string | null {
  if (body === null || body === undefined) return null;

  try {
    if (typeof Document !== 'undefined' && body instanceof Document) {
      return new XMLSerializer().serializeToString(body);
    }
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.toString();
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return formDataToText(body);
    }
    if (body instanceof ArrayBuffer) {
      return decoder.decode(new Uint8Array(body));
    }
    if (ArrayBuffer.isView(body)) {
      return decoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }
  } catch {
    return null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

export interface CollectedRequest {
  facts: RequestFacts;
  requestHeaders: HeaderPair[];
  requestBody: string | null;
  requestBodyTruncated: boolean;
}

export function assembleRequest(
  url: string,
  method: string,
  requestHeaders: HeaderPair[],
  rawBody: string | null,
): CollectedRequest {
  const capped = capBody(rawBody);
  return {
    facts: {
      url,
      method,
      headers: headerPairsToRecord(requestHeaders.map((pair) => [pair.name, pair.value] as const)),
      cookies: readCookies(),
      // Conditions read the capped body, so a rule can never depend on bytes
      // the traffic drawer will not show.
      body: capped.body,
    },
    requestHeaders,
    requestBody: capped.body,
    requestBodyTruncated: capped.truncated,
  };
}
