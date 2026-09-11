import { z } from 'zod';

import { CONFIG_VERSION, createDefaultConfig, type MocksmithConfig } from './config.js';
import { HTTP_METHODS, METHOD_ANY } from './http.js';
import { URL_MATCH_MODES, type RequestMatcher } from './matching.js';
import { NETWORK_ERROR_TYPES, type MockRule, type RuleAction } from './rule.js';

/** Upper bound on a mock delay: 10 minutes is past any real client timeout. */
const MAX_DELAY_MS = 600_000;

export const urlMatcherSchema = z.object({
  mode: z.enum(URL_MATCH_MODES),
  value: z.string(),
  caseSensitive: z.boolean().default(false),
});

export const methodPatternSchema = z.union([z.literal(METHOD_ANY), z.enum(HTTP_METHODS)]);

export const requestMatcherSchema = z.object({
  url: urlMatcherSchema,
  methods: z.array(methodPatternSchema).default([METHOD_ANY]),
});

export const responseBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('json'), value: z.string() }),
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('empty') }),
]);

export const responseHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const respondActionSchema = z.object({
  kind: z.literal('respond'),
  // Lower bound is 200, not 100: the Fetch spec refuses to construct a Response
  // with an informational status, and 1xx is not observable to fetch or XHR.
  status: z.number().int().min(200).max(599).default(200),
  statusText: z.string().default(''),
  headers: z.array(responseHeaderSchema).default([]),
  body: responseBodySchema,
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).default(0),
});

export const networkErrorActionSchema = z.object({
  kind: z.literal('networkError'),
  errorType: z.enum(NETWORK_ERROR_TYPES),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).default(0),
});

export const passthroughActionSchema = z.object({
  kind: z.literal('passthrough'),
});

export const ruleActionSchema = z.discriminatedUnion('kind', [
  respondActionSchema,
  networkErrorActionSchema,
  passthroughActionSchema,
]);

export const mockRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean().default(true),
  matcher: requestMatcherSchema,
  action: ruleActionSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const mocksmithConfigSchema = z.object({
  version: z.number().int(),
  enabled: z.boolean().default(true),
  rules: z.array(mockRuleSchema).default([]),
});

/* -------------------------------------------------------------------------- */
/* Compile-time guard that the schemas and the hand-written types agree.      */
/* A drift on either side turns into a type error here, not a runtime surprise.*/
/* -------------------------------------------------------------------------- */

type Expect<T extends true> = T;
/** Tuple-wrapped so a union operand compares as a whole instead of distributing. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type ParsedMatcher = z.infer<typeof requestMatcherSchema>;
export type ParsedAction = z.infer<typeof ruleActionSchema>;
export type ParsedRule = z.infer<typeof mockRuleSchema>;
export type ParsedConfig = z.infer<typeof mocksmithConfigSchema>;

type _MatcherAgrees = Expect<MutuallyAssignable<ParsedMatcher, RequestMatcher>>;
type _ActionAgrees = Expect<MutuallyAssignable<ParsedAction, RuleAction>>;
type _RuleAgrees = Expect<MutuallyAssignable<ParsedRule, MockRule>>;
type _ConfigAgrees = Expect<MutuallyAssignable<ParsedConfig, MocksmithConfig>>;

/* -------------------------------------------------------------------------- */
/* Tolerant loading                                                           */
/* -------------------------------------------------------------------------- */

/** Only the outer shape, so one bad rule cannot cost the user every other rule. */
const configShellSchema = z.object({
  version: z.number().int().optional(),
  enabled: z.boolean().optional(),
  rules: z.array(z.unknown()).optional(),
});

export interface ConfigLoadResult {
  config: MocksmithConfig;
  /** Rules that failed validation and were left out. */
  droppedRules: number;
  /** True when the stored value was unusable and defaults were substituted. */
  reset: boolean;
}

/**
 * Reads persisted or imported config defensively. Invalid individual rules are
 * dropped and reported rather than rejecting the whole document, because losing
 * a day of mock setup to one malformed entry is not an acceptable failure mode.
 */
export function loadConfig(input: unknown): ConfigLoadResult {
  const shell = configShellSchema.safeParse(input);
  if (!shell.success) {
    return { config: createDefaultConfig(), droppedRules: 0, reset: true };
  }

  const rules: MockRule[] = [];
  let droppedRules = 0;
  for (const raw of shell.data.rules ?? []) {
    const parsed = mockRuleSchema.safeParse(raw);
    if (parsed.success) {
      rules.push(parsed.data);
    } else {
      droppedRules += 1;
    }
  }

  return {
    config: {
      version: CONFIG_VERSION,
      enabled: shell.data.enabled ?? true,
      rules,
    },
    droppedRules,
    reset: false,
  };
}

export function parseRule(input: unknown): MockRule | null {
  const parsed = mockRuleSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
