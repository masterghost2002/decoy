export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

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
  206: 'Partial Content',
  207: 'Multi-Status',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  418: "I'm a Teapot",
  422: 'Unprocessable Content',
  423: 'Locked',
  425: 'Too Early',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  507: 'Insufficient Storage',
  511: 'Network Authentication Required',
};

export interface HttpStatus {
  status: number;
  /** The conventional reason phrase, for showing beside the number. */
  text: string;
}

/**
 * Every status a rule is allowed to answer with, in order. Derived from the
 * reason-phrase table rather than listed twice, so a status can never reach the
 * picker without a name beside it.
 *
 * Informational codes are left out: the Fetch spec refuses to construct a
 * Response below 200, and 1xx is not observable to fetch or XHR anyway.
 */
export const HTTP_STATUSES: readonly HttpStatus[] = Object.keys(STATUS_TEXT)
  .map(Number)
  .filter((status) => status >= 200)
  .sort((a, b) => a - b)
  .map((status) => ({ status, text: STATUS_TEXT[status] ?? '' }));

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
