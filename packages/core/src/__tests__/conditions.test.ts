import { describe, expect, it } from 'vitest';

import {
  createRequestFacts,
  evaluateCondition,
  evaluateConditions,
  headerPairsToRecord,
  parseCookieString,
  type RuleCondition,
} from '../conditions.js';

function condition(overrides: Partial<RuleCondition>): RuleCondition {
  return {
    id: 'c1',
    source: 'header',
    key: '',
    operator: 'equals',
    value: '',
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

const facts = createRequestFacts({
  url: 'https://api.example.com/v1/users?page=2&role=admin',
  method: 'POST',
  headers: { authorization: 'Bearer abc123', 'content-type': 'application/json' },
  cookies: { session: 'staging-7', theme: 'dark' },
  body: '{"user":{"role":"admin","age":31},"tags":["a","b"]}',
});

describe('header conditions', () => {
  it('reads a header case-insensitively by name', () => {
    expect(
      evaluateCondition(
        condition({
          source: 'header',
          key: 'Authorization',
          operator: 'startsWith',
          value: 'Bearer ',
        }),
        facts,
      ),
    ).toBe(true);
  });

  it('distinguishes absent from empty', () => {
    expect(evaluateCondition(condition({ key: 'x-tenant', operator: 'notExists' }), facts)).toBe(
      true,
    );
    expect(evaluateCondition(condition({ key: 'authorization', operator: 'exists' }), facts)).toBe(
      true,
    );
  });

  it('cannot match a value when the header is absent', () => {
    expect(
      evaluateCondition(condition({ key: 'x-tenant', operator: 'equals', value: '' }), facts),
    ).toBe(false);
  });
});

describe('cookie, query and body conditions', () => {
  it('matches a cookie value', () => {
    expect(
      evaluateCondition(
        condition({ source: 'cookie', key: 'session', operator: 'contains', value: 'staging' }),
        facts,
      ),
    ).toBe(true);
  });

  it('matches a query parameter', () => {
    expect(
      evaluateCondition(
        condition({ source: 'query', key: 'role', operator: 'equals', value: 'admin' }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        condition({ source: 'query', key: 'page', operator: 'gt', value: '1' }),
        facts,
      ),
    ).toBe(true);
  });

  it('matches raw body text', () => {
    expect(
      evaluateCondition(
        condition({ source: 'body', operator: 'contains', value: '"role":"admin"' }),
        facts,
      ),
    ).toBe(true);
  });
});

describe('json path conditions', () => {
  it('walks nested objects and arrays', () => {
    expect(
      evaluateCondition(
        condition({ source: 'jsonPath', key: 'user.role', operator: 'equals', value: 'admin' }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        condition({ source: 'jsonPath', key: 'tags.1', operator: 'equals', value: 'b' }),
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        condition({ source: 'jsonPath', key: 'user.age', operator: 'gt', value: '30' }),
        facts,
      ),
    ).toBe(true);
  });

  it('treats an unparseable body as absent rather than throwing', () => {
    const broken = createRequestFacts({ url: 'https://x/y', method: 'POST', body: 'not json{' });
    expect(
      evaluateCondition(
        condition({ source: 'jsonPath', key: 'a.b', operator: 'notExists' }),
        broken,
      ),
    ).toBe(true);
  });

  it('never matches on an invalid regex', () => {
    expect(
      evaluateCondition(
        condition({ key: 'authorization', operator: 'matches', value: '([' }),
        facts,
      ),
    ).toBe(false);
  });
});

describe('combining conditions', () => {
  const yes = condition({ id: 'a', key: 'authorization', operator: 'exists' });
  const no = condition({ id: 'b', key: 'x-missing', operator: 'exists' });

  it('passes when there is nothing to test', () => {
    expect(evaluateConditions([], 'all', facts)).toBe(true);
  });

  it('honours all and any', () => {
    expect(evaluateConditions([yes, no], 'all', facts)).toBe(false);
    expect(evaluateConditions([yes, no], 'any', facts)).toBe(true);
  });

  it('skips disabled conditions entirely', () => {
    expect(evaluateConditions([yes, { ...no, enabled: false }], 'all', facts)).toBe(true);
  });
});

describe('fact parsing', () => {
  it('parses a document.cookie string', () => {
    expect(parseCookieString('session=abc; theme=dark; broken')).toEqual({
      session: 'abc',
      theme: 'dark',
    });
  });

  it('joins repeated headers the way the platform reports them', () => {
    expect(
      headerPairsToRecord([
        ['Accept', 'a'],
        ['accept', 'b'],
      ]),
    ).toEqual({ accept: 'a, b' });
  });
});
