import type { MockRule } from './rule.js';
import { createId } from './id.js';

/** Bumped only for breaking shape changes; additive fields do not need a bump. */
export const CONFIG_VERSION = 1;

export interface MocksmithConfig {
  version: number;
  /** Master switch. When false nothing is intercepted, on any tab. */
  enabled: boolean;
  /** Evaluated top to bottom; the first enabled match wins. */
  rules: MockRule[];
}

export function createDefaultConfig(): MocksmithConfig {
  return { version: CONFIG_VERSION, enabled: true, rules: [] };
}

/**
 * Seeded on first install. The rule is disabled, so it changes no behaviour, but
 * it shows the shape of a rule better than an empty list does.
 */
export function createStarterConfig(now: number): MocksmithConfig {
  const example: MockRule = {
    id: createId('rule'),
    name: 'Example: /api/users returns 404',
    enabled: false,
    matcher: {
      url: { mode: 'contains', value: '/api/users', caseSensitive: false },
      methods: ['GET'],
    },
    action: {
      kind: 'respond',
      status: 404,
      statusText: '',
      headers: [],
      body: {
        type: 'json',
        value: '{\n  "error": {\n    "code": "NOT_FOUND",\n    "message": "No such user"\n  }\n}',
      },
      delayMs: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
  return { version: CONFIG_VERSION, enabled: true, rules: [example] };
}
