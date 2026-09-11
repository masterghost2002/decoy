import {
  HTTP_METHODS,
  METHOD_ANY,
  checkJson,
  createId,
  formatJson,
  type MethodPattern,
  type MockRule,
  type DecoyConfig,
  type ResponseBody,
  type ResponseHeader,
  type TrafficEntry,
} from '@decoy/core';

/**
 * Every editor action is a pure config transform. Keeping them here means the
 * components never hand-splice arrays, and rule ordering -- which is the whole
 * priority model -- stays testable.
 */

export function setMasterEnabled(config: DecoyConfig, enabled: boolean): DecoyConfig {
  return { ...config, enabled };
}

export function upsertRule(config: DecoyConfig, rule: MockRule, now: number): DecoyConfig {
  const stamped: MockRule = { ...rule, updatedAt: now };
  const index = config.rules.findIndex((candidate) => candidate.id === rule.id);

  if (index === -1) {
    return { ...config, rules: [...config.rules, stamped] };
  }

  const rules = [...config.rules];
  rules[index] = stamped;
  return { ...config, rules };
}

export function removeRule(config: DecoyConfig, ruleId: string): DecoyConfig {
  return { ...config, rules: config.rules.filter((rule) => rule.id !== ruleId) };
}

export function setRuleEnabled(
  config: DecoyConfig,
  ruleId: string,
  enabled: boolean,
  now: number,
): DecoyConfig {
  return {
    ...config,
    rules: config.rules.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled, updatedAt: now } : rule,
    ),
  };
}

/** Moves a rule by `offset` positions, clamped to the ends of the list. */
export function moveRule(config: DecoyConfig, ruleId: string, offset: number): DecoyConfig {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  if (index === -1) return config;

  const target = index + offset;
  if (target < 0 || target >= config.rules.length) return config;

  const rules = [...config.rules];
  const [moved] = rules.splice(index, 1);
  if (moved === undefined) return config;
  rules.splice(target, 0, moved);
  return { ...config, rules };
}

/**
 * Moves a rule to an absolute position. This is what a drag-and-drop lands on,
 * and what "move above 02" and an undone deletion both need: a target index
 * rather than an offset.
 */
export function moveRuleToIndex(config: DecoyConfig, ruleId: string, index: number): DecoyConfig {
  const current = config.rules.findIndex((rule) => rule.id === ruleId);
  if (current === -1) return config;
  const target = Math.min(Math.max(index, 0), config.rules.length - 1);
  return moveRule(config, ruleId, target - current);
}

/** Promotes a rule to first position, where it beats everything below it. */
export function moveRuleToTop(config: DecoyConfig, ruleId: string): DecoyConfig {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  if (index <= 0) return config;
  return moveRule(config, ruleId, -index);
}

/** Inserts a copy directly below the original, disabled so it cannot surprise. */
export function duplicateRule(
  config: DecoyConfig,
  ruleId: string,
  now: number,
): { config: DecoyConfig; newRuleId: string | null } {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  const original = config.rules[index];
  if (original === undefined) return { config, newRuleId: null };

  const copy: MockRule = {
    ...original,
    id: createId('rule'),
    name: `${original.name} (copy)`,
    enabled: false,
    createdAt: now,
    updatedAt: now,
  };

  const rules = [...config.rules];
  rules.splice(index + 1, 0, copy);
  return { config: { ...config, rules }, newRuleId: copy.id };
}

export function countEnabledRules(config: DecoyConfig): number {
  return config.rules.reduce((total, rule) => (rule.enabled ? total + 1 : total), 0);
}

/**
 * Seeds a rule from an observed request. Mirrors the status it actually
 * returned, which is the least surprising starting point for "now let me change
 * what this endpoint does".
 *
 * The pattern keeps the host. Matching on the path alone would silently take
 * over the same path on every other origin the page talks to, which is rarely
 * what someone clicking one row in the traffic log means. The query string is
 * dropped, since it is usually the part that varies between calls.
 */
export function ruleFromTrafficEntry(entry: TrafficEntry, now: number): MockRule {
  let pattern = entry.url;
  let path = entry.url;
  try {
    const parsed = new URL(entry.url);
    path = parsed.pathname;
    pattern = `${parsed.host}${parsed.pathname}`;
  } catch {
    // Keep the raw url if it will not parse.
  }

  return {
    id: createId('rule'),
    name: `Mock ${entry.method} ${path}`,
    enabled: true,
    matcher: {
      url: { mode: 'contains', value: pattern, caseSensitive: false },
      methods: [methodPatternFor(entry.method)],
      conditions: [],
      conditionMode: 'all',
    },
    action: {
      kind: 'respond',
      status: statusFor(entry.status),
      statusText: '',
      headers: responseHeadersFor(entry),
      body: bodyFor(entry),
      delayMs: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A page may send any method it likes; a matcher only knows the seven in
 * `HTTP_METHODS`. Anything else becomes "any method", which still narrows the
 * rule to this one url.
 *
 * This is not cosmetic. Every write goes back through validation in the worker,
 * which drops rules it cannot parse -- so an unrecognized method here used to
 * mean the rule was created, sent, silently discarded, and the click appeared
 * to do nothing at all.
 */
function methodPatternFor(method: string): MethodPattern {
  const upper = method.trim().toUpperCase();
  const known: readonly string[] = HTTP_METHODS;
  return known.includes(upper) ? (upper as MethodPattern) : METHOD_ANY;
}

/**
 * The status the rule starts from. A request that never got a response logs no
 * status, and the Fetch spec refuses to construct one below 200, so both land
 * on 200 rather than on a number no rule is allowed to hold.
 */
function statusFor(status: number | null): number {
  if (status === null || !Number.isInteger(status)) return 200;
  if (status < 200 || status > 599) return 200;
  return status;
}

/**
 * Headers the platform recomputes for every response, so carrying them over
 * would either be ignored or actively wrong. Content length in particular: the
 * mocked body is a different length than the real one almost by definition.
 */
const NOT_WORTH_COPYING = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
  'server',
  'set-cookie',
  'age',
  'via',
  'alt-svc',
  'strict-transport-security',
  'content-security-policy',
  'report-to',
  'nel',
]);

/**
 * Everything the real response actually sent back, minus the headers that only
 * describe that particular transfer. Copying them is the point of "Mock this":
 * a rule prefilled with the real content type, cache headers and CORS headers
 * behaves like the endpoint it replaces, and editing one field is a much
 * shorter path than retyping all of them.
 */
function responseHeadersFor(entry: TrafficEntry): ResponseHeader[] {
  const seen = new Set<string>();
  const headers: ResponseHeader[] = [];

  for (const header of entry.responseHeaders) {
    const name = header.name.trim();
    if (name.length === 0) continue;
    const lower = name.toLowerCase();
    if (NOT_WORTH_COPYING.has(lower)) continue;
    // The engine sends these in order and duplicates are legitimate, but a
    // duplicate here is almost always the same value twice.
    if (seen.has(lower)) continue;
    seen.add(lower);
    headers.push({ name, value: header.value });
  }

  return headers;
}

/**
 * The real response body, so the first edit is changing a field rather than
 * inventing the whole payload. `json` when it parses, `text` when it does not
 * -- the raw string is preserved either way, because a deliberately malformed
 * body is a valid thing to mock.
 */
function bodyFor(entry: TrafficEntry): ResponseBody {
  const captured = entry.responseBody;
  if (captured === null || captured.length === 0) {
    // Nothing was captured: not textual, opaque, or the body never arrived.
    return { type: 'json', value: '{}' };
  }

  if (checkJson(captured).valid) {
    // Pretty-printed, because this is about to be read and edited by hand.
    return { type: 'json', value: formatJson(captured) };
  }
  return { type: 'text', value: captured };
}
