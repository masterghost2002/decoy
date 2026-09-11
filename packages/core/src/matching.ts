import {
  evaluateConditions,
  type ConditionMode,
  type RequestFacts,
  type RuleCondition,
} from './conditions.js';
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
  /** Extra tests on headers, cookies, query and payload. Empty means "no extra tests". */
  conditions: RuleCondition[];
  conditionMode: ConditionMode;
}

/**
 * The shape the engine needs to make a decision, independent of fetch/XHR/DNR.
 * Headers, cookies and body are optional: a caller that only knows the url and
 * method still gets url and method matching, and any rule carrying conditions
 * simply will not match.
 */
export interface InterceptedRequest {
  url: string;
  method: string;
  headers?: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
  body?: string | null;
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

export function wildcardToRegExpSource(pattern: string, capture = false): string {
  // Replacement strings are not rescanned, so the parentheses introduced for
  // one wildcard cannot be mistaken for part of the next.
  const escaped = escapeExceptWildcards(pattern)
    .replace(/\*/g, capture ? '(.*)' : '.*')
    .replace(/\?/g, capture ? '(.)' : '.');
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

/** True when the pattern already names a scheme, so it is meant literally. */
function hasScheme(pattern: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) || pattern.startsWith('//');
}

/**
 * The urls a pattern is allowed to be compared against.
 *
 * The traffic panel displays urls with the scheme stripped
 * (`api.example.com/v1/users`), and pasting exactly what you see is the obvious
 * thing to do. In the anchored modes -- `equals`, `startsWith`, `wildcard` --
 * that would never match, which reads as "this tool does not accept a full url
 * with a domain". So a pattern that does not name a scheme is also compared
 * against the url with its scheme removed.
 *
 * Deliberately *not* extended to the path alone: `startsWith` is documented as
 * matching from the start of the full url, and quietly making it match paths
 * too would trade one surprise for another. `contains` is the mode for that,
 * and it is the default.
 */
export function urlMatchCandidates(url: string, pattern: string): string[] {
  if (hasScheme(pattern)) return [url];

  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return [url];
  return [url, url.slice(schemeEnd + 3)];
}

export function matchesUrl(matcher: UrlMatcher, url: string): boolean {
  const pattern = matcher.value;
  if (pattern.length === 0) return false;

  if (matcher.mode === 'regex') {
    // Unanchored and compared to the real url only: a regex author is precise
    // on purpose, and quietly widening the haystack would betray that.
    const regex = compileRegExp(pattern, matcher.caseSensitive ? '' : 'i');
    // An invalid pattern must never match, or one typo silently hijacks every request.
    return regex !== null && regex.test(url);
  }

  const candidates = urlMatchCandidates(url, pattern);

  if (matcher.mode === 'wildcard') {
    const regex = compileRegExp(
      wildcardToRegExpSource(pattern),
      matcher.caseSensitive ? '' : 'i',
    );
    if (regex === null) return false;
    return candidates.some((candidate) => regex.test(candidate));
  }

  const needle = matcher.caseSensitive ? pattern : pattern.toLowerCase();

  return candidates.some((candidate) => {
    const haystack = matcher.caseSensitive ? candidate : candidate.toLowerCase();
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
  });
}

/**
 * What the url pattern captured, for a handler's `req.params`.
 *
 * Named groups in `regex` mode come back under their names, so
 * `/users/(?<id>\\d+)` reads like an Express route. `wildcard` mode returns its
 * `*` and `?` captures positionally under "0", "1", ... The other four modes
 * capture nothing, because there is nothing in them to capture.
 *
 * Separate from `matchesUrl` on purpose: matching happens for every rule on
 * every request and must stay as cheap as it is, while captures are only ever
 * needed for the one rule that won and only when it runs code.
 */
export function urlCaptures(matcher: UrlMatcher, url: string): Record<string, string> {
  const pattern = matcher.value;
  if (pattern.length === 0) return {};
  const flags = matcher.caseSensitive ? '' : 'i';

  if (matcher.mode === 'regex') {
    const regex = compileRegExp(pattern, flags);
    return regex === null ? {} : capturesOf(regex.exec(url));
  }

  if (matcher.mode === 'wildcard') {
    const regex = compileRegExp(wildcardToRegExpSource(pattern, true), flags);
    if (regex === null) return {};
    for (const candidate of urlMatchCandidates(url, pattern)) {
      const found = regex.exec(candidate);
      if (found !== null) return capturesOf(found);
    }
  }

  return {};
}

function capturesOf(found: RegExpExecArray | null): Record<string, string> {
  if (found === null) return {};
  const captures: Record<string, string> = {};
  // Positional first, so a named group of the same index wins over its number.
  for (let index = 1; index < found.length; index += 1) {
    const value = found[index];
    if (value !== undefined) captures[String(index - 1)] = value;
  }
  for (const [name, value] of Object.entries(found.groups ?? {})) {
    if (typeof value === 'string') captures[name] = value;
  }
  return captures;
}

export function matchesMethod(methods: MethodPattern[], method: string): boolean {
  if (methods.length === 0) return true;
  if (methods.includes(METHOD_ANY)) return true;
  const normalized = method.toUpperCase();
  return methods.some((candidate) => candidate === normalized);
}

function factsFor(request: InterceptedRequest): RequestFacts {
  return {
    url: request.url,
    method: request.method,
    headers: request.headers ?? {},
    cookies: request.cookies ?? {},
    body: request.body ?? null,
  };
}

export function matchesRequest(
  matcher: RequestMatcher,
  request: InterceptedRequest,
): boolean {
  if (!matchesMethod(matcher.methods, request.method)) return false;
  if (!matchesUrl(matcher.url, request.url)) return false;
  // Cheapest tests first: conditions can parse json, so they run last.
  return evaluateConditions(
    matcher.conditions ?? [],
    matcher.conditionMode ?? 'all',
    factsFor(request),
  );
}
