export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Sentinel in a matcher's method list meaning "any method". */
export const METHOD_ANY = '*';

export type MethodPattern = HttpMethod | typeof METHOD_ANY;

/**
 * Reason phrases for the statuses a mock is actually likely to use. Missing
 * entries fall back to an empty string, which browsers render fine.
 */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  418: "I'm a Teapot",
  422: 'Unprocessable Content',
  425: 'Too Early',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function defaultStatusText(status: number): string {
  return STATUS_TEXT[status] ?? '';
}

/**
 * Statuses the Fetch spec forbids a body on. Sending one anyway throws when
 * constructing a Response, so the interceptor has to drop the body instead.
 */
export function statusForbidsBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}
