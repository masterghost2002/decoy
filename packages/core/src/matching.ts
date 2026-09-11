import { METHOD_ANY, type MethodPattern } from './http.js';

export const URL_MATCH_MODES = [
  'contains',
  'equals',
  'startsWith',
  'endsWith',
  'wildcard',
  'regex',
] as const;

export type UrlMatchMode = (typeof URL_MATCH_MODES)[number];

export interface UrlMatcher {
  mode: UrlMatchMode;
  value: string;
  caseSensitive: boolean;
}

export interface RequestMatcher {
  url: UrlMatcher;
  methods: MethodPattern[];
}

/** The shape the engine needs to make a decision, independent of fetch/XHR/DNR. */
export interface InterceptedRequest {
  url: string;
  method: string;
}

const MAX_CACHED_PATTERNS = 500;
/** A `null` entry records a pattern that failed to compile, so we only pay for it once. */
const regexCache = new Map<string, RegExp | null>();

/**
 * Escapes regex metacharacters except `*` and `?`, which stay live so wildcard
 * patterns can use them.
 */
function escapeExceptWildcards(pattern: string): string {
  return pattern.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
}

export function wildcardToRegExpSource(pattern: string): string {
  const escaped = escapeExceptWildcards(pattern).replace(/\*/g, '.*').replace(/\?/g, '.');
  return `^${escaped}$`;
}

export function compileRegExp(source: string, flags: string): RegExp | null {
  const key = `${flags} ${source}`;
  const cached = regexCache.get(key);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(source, flags);
  } catch {
    compiled = null;
  }

  if (regexCache.size >= MAX_CACHED_PATTERNS) regexCache.clear();
  regexCache.set(key, compiled);
  return compiled;
}

/** True when `source` is a usable regular expression, so the editor can warn early. */
export function isValidRegExp(source: string): boolean {
  return compileRegExp(source, '') !== null;
}

export function matchesUrl(matcher: UrlMatcher, url: string): boolean {
  const pattern = matcher.value;
  if (pattern.length === 0) return false;

  if (matcher.mode === 'regex' || matcher.mode === 'wildcard') {
    const source = matcher.mode === 'regex' ? pattern : wildcardToRegExpSource(pattern);
    const regex = compileRegExp(source, matcher.caseSensitive ? '' : 'i');
    // An invalid pattern must never match, or one typo silently hijacks every request.
    return regex !== null && regex.test(url);
  }

  const haystack = matcher.caseSensitive ? url : url.toLowerCase();
  const needle = matcher.caseSensitive ? pattern : pattern.toLowerCase();

  switch (matcher.mode) {
    case 'equals':
      return haystack === needle;
    case 'contains':
      return haystack.includes(needle);
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'endsWith':
      return haystack.endsWith(needle);
  }
}

export function matchesMethod(methods: MethodPattern[], method: string): boolean {
  if (methods.length === 0) return true;
  if (methods.includes(METHOD_ANY)) return true;
  const normalized = method.toUpperCase();
  return methods.some((candidate) => candidate === normalized);
}

export function matchesRequest(
  matcher: RequestMatcher,
  request: InterceptedRequest,
): boolean {
  return matchesMethod(matcher.methods, request.method) && matchesUrl(matcher.url, request.url);
}
