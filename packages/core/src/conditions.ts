/**
 * Conditions narrow a rule beyond url and method: "this POST, but only when the
 * Authorization header is missing", "only when the payload's role is admin",
 * "only when the session cookie says staging".
 *
 * Everything here is pure and string-based. The page-world patch collects the
 * facts; this module only decides.
 */

export const CONDITION_SOURCES = ['header', 'cookie', 'query', 'body', 'jsonPath'] as const;
export type ConditionSource = (typeof CONDITION_SOURCES)[number];

export const CONDITION_OPERATORS = [
  'exists',
  'notExists',
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'matches',
  'gt',
  'lt',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that ignore the comparison value, so the editor can hide the field. */
export const VALUELESS_OPERATORS: ReadonlySet<ConditionOperator> = new Set<ConditionOperator>([
  'exists',
  'notExists',
]);

/** Sources that read the request as a whole rather than a named key. */
export const KEYLESS_SOURCES: ReadonlySet<ConditionSource> = new Set<ConditionSource>(['body']);

export interface RuleCondition {
  id: string;
  source: ConditionSource;
  /** Header name, cookie name, query parameter, or a dotted json path. */
  key: string;
  operator: ConditionOperator;
  value: string;
  caseSensitive: boolean;
  /** Off by default so a half-written condition never silently blocks a rule. */
  enabled: boolean;
}

export type ConditionMode = 'all' | 'any';

/**
 * What the page can tell us about a request at decision time. Headers and
 * cookies arrive with lowercased keys; body is the raw serialized payload, or
 * null when there is none or it is not text.
 */
export interface RequestFacts {
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  cookies: Readonly<Record<string, string>>;
  body: string | null;
}

export function createRequestFacts(partial: Partial<RequestFacts> & { url: string; method: string }): RequestFacts {
  return {
    headers: {},
    cookies: {},
    body: null,
    ...partial,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a value out of the request                                         */
/* -------------------------------------------------------------------------- */

function readQueryParam(url: string, key: string): string | null {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return null;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  // URLSearchParams handles repeated keys and percent-decoding for us.
  const params = new URLSearchParams(query);
  return params.get(key);
}

/**
 * Walks a dotted path through parsed JSON. Numeric segments index arrays, so
 * `items.0.id` works. Returns null for a missing path or unparseable body.
 */
function readJsonPath(body: string | null, path: string): string | null {
  if (body === null || body.length === 0) return null;

  let current: unknown;
  try {
    current = JSON.parse(body);
  } catch {
    return null;
  }

  if (path.trim().length === 0) return null;

  for (const rawSegment of path.split('.')) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (current === null || typeof current !== 'object') return null;

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) return null;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined) return null;
  }

  if (current === undefined || current === null) return null;
  if (typeof current === 'object') return JSON.stringify(current);
  return String(current);
}

/** `null` means "absent", which is what `exists` / `notExists` test for. */
export function readConditionValue(
  condition: RuleCondition,
  facts: RequestFacts,
): string | null {
  switch (condition.source) {
    case 'header':
      return facts.headers[condition.key.trim().toLowerCase()] ?? null;
    case 'cookie':
      return facts.cookies[condition.key.trim()] ?? null;
    case 'query':
      return readQueryParam(facts.url, condition.key.trim());
    case 'body':
      return facts.body;
    case 'jsonPath':
      return readJsonPath(facts.body, condition.key);
  }
}

/* -------------------------------------------------------------------------- */
/* Comparing                                                                  */
/* -------------------------------------------------------------------------- */

function compareNumeric(actual: string, expected: string, want: 'gt' | 'lt'): boolean {
  const left = Number.parseFloat(actual);
  const right = Number.parseFloat(expected);
  // A non-numeric operand can never satisfy a numeric comparison, and must not
  // throw either -- NaN comparisons are already false, but be explicit.
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return want === 'gt' ? left > right : left < right;
}

export function evaluateCondition(condition: RuleCondition, facts: RequestFacts): boolean {
  const actual = readConditionValue(condition, facts);

  if (condition.operator === 'exists') return actual !== null;
  if (condition.operator === 'notExists') return actual === null;

  // Every remaining operator needs something to compare against.
  if (actual === null) return false;

  if (condition.operator === 'matches') {
    let regex: RegExp;
    try {
      regex = new RegExp(condition.value, condition.caseSensitive ? '' : 'i');
    } catch {
      // An invalid pattern must never match, or one typo hijacks the rule.
      return false;
    }
    return regex.test(actual);
  }

  if (condition.operator === 'gt' || condition.operator === 'lt') {
    return compareNumeric(actual, condition.value, condition.operator);
  }

  const left = condition.caseSensitive ? actual : actual.toLowerCase();
  const right = condition.caseSensitive ? condition.value : condition.value.toLowerCase();

  switch (condition.operator) {
    case 'equals':
      return left === right;
    case 'notEquals':
      return left !== right;
    case 'contains':
      return left.includes(right);
    case 'notContains':
      return !left.includes(right);
    case 'startsWith':
      return left.startsWith(right);
    case 'endsWith':
      return left.endsWith(right);
  }
}

/**
 * Disabled conditions are skipped entirely. An empty set always passes, so a
 * rule with no conditions behaves exactly as it did before conditions existed.
 */
export function evaluateConditions(
  conditions: readonly RuleCondition[],
  mode: ConditionMode,
  facts: RequestFacts,
): boolean {
  const active = conditions.filter((condition) => condition.enabled);
  if (active.length === 0) return true;
  return mode === 'any'
    ? active.some((condition) => evaluateCondition(condition, facts))
    : active.every((condition) => evaluateCondition(condition, facts));
}

/* -------------------------------------------------------------------------- */
/* Parsing helpers shared by the page patches and the UI                      */
/* -------------------------------------------------------------------------- */

/** `document.cookie` into a map. Values stay percent-encoded if they will not decode. */
export function parseCookieString(cookieString: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name.length === 0) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export function headerPairsToRecord(
  pairs: Iterable<readonly [string, string]>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    // Repeated headers are joined the way the platform reports them.
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

export function describeCondition(condition: RuleCondition): string {
  const target =
    condition.source === 'body'
      ? 'body'
      : `${condition.source} ${condition.key.length > 0 ? condition.key : '—'}`;
  if (VALUELESS_OPERATORS.has(condition.operator)) return `${target} ${condition.operator}`;
  return `${target} ${condition.operator} ${condition.value}`;
}
