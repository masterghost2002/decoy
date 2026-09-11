import { describe, expect, it } from 'vitest';

import {
  matchesMethod,
  matchesRequest,
  matchesUrl,
  wildcardToRegExpSource,
  type UrlMatcher,
} from '../matching.js';
import { METHOD_ANY } from '../http.js';

function matcher(partial: Partial<UrlMatcher>): UrlMatcher {
  return { mode: 'contains', value: '', caseSensitive: false, ...partial };
}

const API_URL = 'https://api.example.com/v1/users?page=2';

describe('matchesUrl', () => {
  it('never matches on an empty pattern', () => {
    for (const mode of ['contains', 'equals', 'startsWith', 'wildcard', 'regex'] as const) {
      expect(matchesUrl(matcher({ mode, value: '' }), API_URL)).toBe(false);
    }
  });

  it('matches substrings, prefixes and suffixes', () => {
    expect(matchesUrl(matcher({ mode: 'contains', value: '/v1/users' }), API_URL)).toBe(true);
    expect(matchesUrl(matcher({ mode: 'contains', value: '/v2/users' }), API_URL)).toBe(false);
    expect(
      matchesUrl(matcher({ mode: 'startsWith', value: 'https://api.example.com' }), API_URL),
    ).toBe(true);
    expect(matchesUrl(matcher({ mode: 'startsWith', value: '/v1' }), API_URL)).toBe(false);
    expect(matchesUrl(matcher({ mode: 'endsWith', value: 'page=2' }), API_URL)).toBe(true);
  });

  it('requires the whole url for equals', () => {
    expect(matchesUrl(matcher({ mode: 'equals', value: API_URL }), API_URL)).toBe(true);
    expect(
      matchesUrl(matcher({ mode: 'equals', value: 'https://api.example.com/v1/users' }), API_URL),
    ).toBe(false);
  });

  it('ignores case unless asked not to', () => {
    const value = '/V1/USERS';
    expect(matchesUrl(matcher({ mode: 'contains', value }), API_URL)).toBe(true);
    expect(matchesUrl(matcher({ mode: 'contains', value, caseSensitive: true }), API_URL)).toBe(
      false,
    );
  });
});

describe('wildcard matching', () => {
  it('anchors the pattern so a bare path does not match a full url', () => {
    expect(matchesUrl(matcher({ mode: 'wildcard', value: '/v1/users' }), API_URL)).toBe(false);
    expect(matchesUrl(matcher({ mode: 'wildcard', value: '*/v1/users*' }), API_URL)).toBe(true);
  });

  it('treats * as any run of characters and ? as exactly one', () => {
    expect(
      matchesUrl(matcher({ mode: 'wildcard', value: 'https://api.example.com/*/users*' }), API_URL),
    ).toBe(true);
    expect(matchesUrl(matcher({ mode: 'wildcard', value: '*/v?/users*' }), API_URL)).toBe(true);
    expect(matchesUrl(matcher({ mode: 'wildcard', value: '*/v??/users*' }), API_URL)).toBe(false);
  });

  it('escapes regex metacharacters that appear in real urls', () => {
    // A literal dot must not behave as "any character".
    expect(matchesUrl(matcher({ mode: 'wildcard', value: '*api.example.com*' }), API_URL)).toBe(
      true,
    );
    expect(matchesUrl(matcher({ mode: 'wildcard', value: '*apiXexampleXcom*' }), API_URL)).toBe(
      false,
    );
    // Known wart of wildcard mode: `?` is a single-character wildcard, so a
    // literal `?` before a query string cannot be expressed. Use regex mode.
    expect(
      matchesUrl(
        matcher({ mode: 'wildcard', value: '*users?page=2' }),
        'https://api.example.com/v1/usersXpage=2',
      ),
    ).toBe(true);
    // Grouping and repetition characters do appear in real paths and stay literal.
    expect(
      matchesUrl(
        matcher({ mode: 'wildcard', value: '*/a+b/(c)/*' }),
        'https://x.test/a+b/(c)/d',
      ),
    ).toBe(true);
  });

  it('produces an anchored source', () => {
    expect(wildcardToRegExpSource('a*b')).toBe('^a.*b$');
  });
});

describe('regex matching', () => {
  it('matches unanchored by default, like a regex should', () => {
    expect(matchesUrl(matcher({ mode: 'regex', value: '/v\\d+/users' }), API_URL)).toBe(true);
  });

  it('does not match when the pattern fails to compile', () => {
    // A half-typed pattern must not fall back to matching everything.
    expect(matchesUrl(matcher({ mode: 'regex', value: '([unclosed' }), API_URL)).toBe(false);
  });
});

describe('matchesMethod', () => {
  it('accepts anything for the wildcard or an empty list', () => {
    expect(matchesMethod([METHOD_ANY], 'DELETE')).toBe(true);
    expect(matchesMethod([], 'DELETE')).toBe(true);
  });

  it('compares case-insensitively against the listed methods', () => {
    expect(matchesMethod(['GET', 'POST'], 'post')).toBe(true);
    expect(matchesMethod(['GET', 'POST'], 'PUT')).toBe(false);
  });
});

describe('urls pasted without a scheme', () => {
  // The traffic panel shows `api.example.com/v1/users`, so that is what people
  // paste. Before this, every anchored mode silently failed on it.
  const PASTED = 'api.example.com/v1/users';

  it('matches in the anchored modes', () => {
    expect(matchesUrl(matcher({ mode: 'equals', value: 'api.example.com/v1/users?page=2' }), API_URL)).toBe(true);
    expect(matchesUrl(matcher({ mode: 'startsWith', value: PASTED }), API_URL)).toBe(true);
    expect(matchesUrl(matcher({ mode: 'wildcard', value: 'api.example.com/v1/*' }), API_URL)).toBe(true);
  });

  it('still respects a scheme when one is given', () => {
    expect(matchesUrl(matcher({ mode: 'startsWith', value: 'http://api.example.com' }), API_URL)).toBe(false);
    expect(matchesUrl(matcher({ mode: 'startsWith', value: 'https://api.example.com' }), API_URL)).toBe(true);
  });

  it('does not quietly widen startsWith to bare paths', () => {
    expect(matchesUrl(matcher({ mode: 'startsWith', value: '/v1' }), API_URL)).toBe(false);
  });
});

describe('matchesRequest', () => {
  it('requires both the method and the url to match', () => {
    const request = { url: API_URL, method: 'GET' };
    expect(
      matchesRequest(
        { url: matcher({ mode: 'contains', value: '/v1/users' }), methods: ['GET'], conditions: [], conditionMode: 'all' },
        request,
      ),
    ).toBe(true);
    expect(
      matchesRequest(
        { url: matcher({ mode: 'contains', value: '/v1/users' }), methods: ['POST'], conditions: [], conditionMode: 'all' },
        request,
      ),
    ).toBe(false);
  });
});
