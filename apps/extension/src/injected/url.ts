/**
 * Rules are written against the urls a developer sees in the network panel, so
 * relative request urls are resolved before matching.
 */
export function absolutizeUrl(url: string): string {
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : location.href;
    return new URL(url, base).href;
  } catch {
    // Opaque or malformed input still deserves a matching attempt as-is.
    return url;
  }
}

export function isRequestObject(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

export interface RequestDescriptor {
  url: string;
  method: string;
}

export function describeFetchRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestDescriptor {
  let rawUrl: string;
  let method: string;

  if (typeof input === 'string') {
    rawUrl = input;
    method = init?.method ?? 'GET';
  } else if (typeof URL !== 'undefined' && input instanceof URL) {
    rawUrl = input.href;
    method = init?.method ?? 'GET';
  } else if (isRequestObject(input)) {
    rawUrl = input.url;
    method = init?.method ?? input.method;
  } else {
    rawUrl = String(input);
    method = init?.method ?? 'GET';
  }

  return { url: absolutizeUrl(rawUrl), method: method.toUpperCase() };
}

export function resolveAbortSignal(
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | null {
  if (init && 'signal' in init && init.signal) return init.signal;
  if (isRequestObject(input)) return input.signal;
  return null;
}
