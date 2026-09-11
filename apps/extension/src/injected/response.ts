import type { RespondPlan } from '@mocksmith/core';

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
