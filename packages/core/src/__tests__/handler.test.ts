import { describe, expect, it } from 'vitest';

import { createHandlerAction, createRule } from '../factory.js';
import { decideRequest, findMatchingRuleFrom } from '../engine.js';
import {
  actionFromHandlerOutcome,
  handlerErrorAction,
  isHandlerCallMessage,
  isHandlerReplyMessage,
  HANDLER_CHANNEL,
  type HandlerOutcome,
} from '../handler.js';
import { urlCaptures } from '../matching.js';
import { findShadowedRules, firstUrlMatch, ruleCovers } from '../shadow.js';
import { resolveAction } from '../resolve.js';
import { applyRuleEdits, ruleEditsEqual } from '../rule.js';
import type { MockRule, DecoyConfig, UrlMatchMode } from '../index.js';

function config(rules: MockRule[]): DecoyConfig {
  return { version: 1, enabled: true, rules };
}

function rule(overrides: Partial<MockRule> = {}): MockRule {
  return { ...createRule(0, 'r'), ...overrides };
}

describe('actionFromHandlerOutcome', () => {
  it('turns a respond outcome into an ordinary respond action', () => {
    const action = actionFromHandlerOutcome({
      kind: 'respond',
      status: 201,
      statusText: '',
      headers: [{ name: 'X-Made-Up', value: '1' }],
      body: '{"id":1}',
      bodyType: 'json',
      delayMs: 30,
    });

    expect(action).toEqual({
      kind: 'respond',
      status: 201,
      statusText: '',
      headers: [{ name: 'X-Made-Up', value: '1' }],
      body: { type: 'json', value: '{"id":1}' },
      delayMs: 30,
    });
  });

  it('answers with no body at all when the handler sent none', () => {
    const action = actionFromHandlerOutcome({
      kind: 'respond',
      status: 204,
      statusText: '',
      headers: [],
      body: null,
      bodyType: 'json',
      delayMs: 0,
    });
    expect(action).toMatchObject({ body: { type: 'empty' } });
  });

  it('gives every streamed chunk an id, so the editor can hold the result', () => {
    const action = actionFromHandlerOutcome({
      kind: 'stream',
      status: 200,
      statusText: '',
      headers: [],
      chunks: ['{"n":1}', '{"n":2}'],
      format: 'ndjson',
      delayMs: 0,
      intervalMs: 50,
      repeat: 1,
    });

    if (action === null || action.kind !== 'stream') throw new Error('expected a stream action');
    expect(action.chunks.map((chunk) => chunk.value)).toEqual(['{"n":1}', '{"n":2}']);
    expect(new Set(action.chunks.map((chunk) => chunk.id)).size).toBe(2);
  });

  it('maps failing and passing through onto the actions that already exist', () => {
    expect(actionFromHandlerOutcome({ kind: 'fail', errorType: 'timeout', delayMs: 5 })).toEqual({
      kind: 'networkError',
      errorType: 'timeout',
      delayMs: 5,
    });
    expect(actionFromHandlerOutcome({ kind: 'passthrough' })).toEqual({ kind: 'passthrough' });
  });

  it('reports next() as "no action", which is how the caller knows to keep looking', () => {
    expect(actionFromHandlerOutcome({ kind: 'next' })).toBeNull();
  });

  it('produces plans the transports already understand', () => {
    // The whole point of normalizing: nothing downstream of here is new code.
    const outcomes: HandlerOutcome[] = [
      {
        kind: 'respond',
        status: 200,
        statusText: '',
        headers: [],
        body: '{}',
        bodyType: 'json',
        delayMs: 0,
      },
      {
        kind: 'stream',
        status: 200,
        statusText: '',
        headers: [],
        chunks: ['a'],
        format: 'sse',
        delayMs: 0,
        intervalMs: 10,
        repeat: 1,
      },
      { kind: 'fail', errorType: 'failed', delayMs: 0 },
      { kind: 'passthrough' },
    ];

    for (const outcome of outcomes) {
      const action = actionFromHandlerOutcome(outcome);
      if (action === null) throw new Error('expected an action');
      expect(['respond', 'stream', 'networkError', 'passthrough']).toContain(
        resolveAction(action).kind,
      );
    }
  });

  it('sets the json content type on a handler response, like any other', () => {
    const action = actionFromHandlerOutcome({
      kind: 'respond',
      status: 200,
      statusText: '',
      headers: [],
      body: '{"a":1}',
      bodyType: 'json',
      delayMs: 0,
    });
    if (action === null) throw new Error('expected an action');
    const plan = resolveAction(action);
    if (plan.kind !== 'respond') throw new Error('expected a respond plan');
    expect(plan.headers).toEqual([['content-type', 'application/json']]);
  });
});

describe('handlerErrorAction', () => {
  it('answers 500 with the error, rather than escaping to the real network', () => {
    // A handler that crashed and then quietly let the request through can
    // mutate real data, and hides the bug behind an app that looks fine.
    const plan = resolveAction(handlerErrorAction('ReferenceError: nope is not defined'));
    if (plan.kind !== 'respond') throw new Error('expected a respond plan');
    expect(plan.status).toBe(500);
    expect(plan.body).toContain('nope is not defined');
    // Header names are passed through as written; only the content type is
    // added by the resolver, and that one is lowercase.
    expect(plan.headers).toContainEqual(['X-Decoy-Error', 'handler']);
  });
});

describe('handler messages', () => {
  it('recognizes its own traffic and nothing else', () => {
    const call = {
      channel: HANDLER_CHANNEL,
      kind: 'call',
      id: 'c1',
      ruleId: 'r1',
      code: '',
      request: {},
      timeoutMs: 10,
    };
    expect(isHandlerCallMessage(call)).toBe(true);
    expect(isHandlerCallMessage({ ...call, channel: 'someone.else' })).toBe(false);
    expect(isHandlerCallMessage(null)).toBe(false);
    expect(isHandlerCallMessage('a string')).toBe(false);

    expect(isHandlerReplyMessage({ channel: HANDLER_CHANNEL, kind: 'result' })).toBe(true);
    expect(isHandlerReplyMessage({ channel: HANDLER_CHANNEL, kind: 'log' })).toBe(true);
    expect(isHandlerReplyMessage(call)).toBe(false);
  });
});

describe('urlCaptures', () => {
  const matcher = (mode: UrlMatchMode, value: string) => ({ mode, value, caseSensitive: false });

  it('reads named groups out of a regex pattern', () => {
    expect(
      urlCaptures(matcher('regex', '/users/(?<id>\\d+)/posts/(?<postId>\\d+)'), 'https://x.dev/users/42/posts/7'),
    ).toEqual({ 0: '42', 1: '7', id: '42', postId: '7' });
  });

  it('captures wildcards positionally', () => {
    // The full url is tried before the scheme-stripped one, exactly as
    // matching does it, so a leading `*` captures the scheme as well.
    expect(urlCaptures(matcher('wildcard', '*/api/users/*'), 'https://x.dev/api/users/42')).toEqual(
      { 0: 'https://x.dev', 1: '42' },
    );
  });

  it('matches a wildcard against the scheme-stripped url too, like matching does', () => {
    expect(urlCaptures(matcher('wildcard', 'x.dev/api/*'), 'https://x.dev/api/thing')).toEqual({
      0: 'thing',
    });
  });

  it('captures a single character for ?', () => {
    expect(urlCaptures(matcher('wildcard', '*/v?/users'), 'https://x.dev/v2/users')).toEqual({
      0: 'https://x.dev',
      1: '2',
    });
  });

  it('finds nothing in the four literal modes, because there is nothing to find', () => {
    for (const mode of ['contains', 'equals', 'startsWith', 'endsWith'] as UrlMatchMode[]) {
      expect(urlCaptures(matcher(mode, '/api/users'), 'https://x.dev/api/users')).toEqual({});
    }
  });

  it('finds nothing rather than throwing on a pattern that will not compile', () => {
    expect(urlCaptures(matcher('regex', '('), 'https://x.dev/a')).toEqual({});
    expect(urlCaptures(matcher('regex', '.'), 'https://x.dev/a')).toEqual({});
    expect(urlCaptures(matcher('contains', ''), 'https://x.dev/a')).toEqual({});
  });

  it('finds nothing when the pattern does not match the url at all', () => {
    expect(urlCaptures(matcher('regex', '/users/(?<id>\\d+)'), 'https://x.dev/orders/1')).toEqual(
      {},
    );
  });
});

describe('shadowing, with handlers in the list', () => {
  const url = (value: string) => ({
    url: { mode: 'contains' as const, value, caseSensitive: false },
    methods: ['*' as const],
    conditions: [],
    conditionMode: 'all' as const,
  });

  it('never reports a handler as hiding the rules below it', () => {
    // The middleware arrangement: a handler above the rules it guards, which
    // matches everything they do and hands most of it on. Warning about that
    // would put a "never fires" badge on the intended setup.
    const rules = [
      rule({ id: 'gate', matcher: url('/api/'), action: createHandlerAction('return next();') }),
      rule({ id: 'users', matcher: url('/api/users') }),
    ];
    expect(findShadowedRules(rules)).toEqual({});
    expect(ruleCovers(rules[0] as MockRule, rules[1] as MockRule)).toBe(false);
  });

  it('still reports a plain rule that really does hide the one below it', () => {
    // The guard against the fix above being a blanket exemption.
    const rules = [
      rule({ id: 'broad', matcher: url('/api/') }),
      rule({ id: 'users', matcher: url('/api/users') }),
    ];
    expect(findShadowedRules(rules)['users']).toMatchObject({ shadowedBy: 'broad' });
  });

  it('reports a handler as an uncertain winner in the url tester', () => {
    const rules = [
      rule({ id: 'gate', matcher: url('/api/users'), action: createHandlerAction('return next();') }),
      rule({ id: 'users', matcher: url('/api/users') }),
    ];
    const outcome = firstUrlMatch(rules, 'https://x.dev/api/users');
    // It might answer and it might decline, so the honest answer names the
    // rule that is decided by the url alone, and flags the doubt.
    expect(outcome.rule?.id).toBe('users');
    expect(outcome.uncertain).toBe(true);
  });
});

describe('findMatchingRuleFrom', () => {
  const url = (value: string) => ({
    url: { mode: 'contains' as const, value, caseSensitive: false },
    methods: ['*' as const],
    conditions: [],
    conditionMode: 'all' as const,
  });

  const rules = [
    rule({ id: 'a', matcher: url('/api/') }),
    rule({ id: 'b', matcher: url('/api/users') }),
    rule({ id: 'c', matcher: url('/api/users') }),
  ];

  it('finds the first match from the top', () => {
    const found = findMatchingRuleFrom(config(rules), { url: '/api/users', method: 'GET' });
    expect(found).toMatchObject({ index: 0 });
    expect(found?.rule.id).toBe('a');
  });

  it('resumes below a rule, which is what next() needs', () => {
    const found = findMatchingRuleFrom(config(rules), { url: '/api/users', method: 'GET' }, 1);
    expect(found?.rule.id).toBe('b');
    expect(findMatchingRuleFrom(config(rules), { url: '/api/users', method: 'GET' }, 2)?.rule.id).toBe(
      'c',
    );
  });

  it('runs out rather than wrapping around, so next() cannot loop forever', () => {
    expect(findMatchingRuleFrom(config(rules), { url: '/api/users', method: 'GET' }, 3)).toBeNull();
  });

  it('skips disabled rules on the way down', () => {
    const withDisabled = [rules[0], { ...rules[1], enabled: false }, rules[2]] as MockRule[];
    expect(
      findMatchingRuleFrom(config(withDisabled), { url: '/api/users', method: 'GET' }, 1)?.rule.id,
    ).toBe('c');
  });

  it('reports the index a decision came from', () => {
    const decision = decideRequest(config(rules), { url: '/api/users', method: 'GET' }, 1);
    expect(decision).toMatchObject({ index: 1 });
  });
});

describe('ruleEditsEqual', () => {
  const base = createRule(1000, 'Users 404');

  it('ignores the timestamp that saving stamps', () => {
    // The shipped bug: saving rewrote updatedAt, the draft did not have it, and
    // the Save button stayed enabled on a form with nothing left to save.
    expect(ruleEditsEqual(base, { ...base, updatedAt: 2000 })).toBe(true);
  });

  it('ignores the switch the list owns, not the form', () => {
    expect(ruleEditsEqual(base, { ...base, enabled: !base.enabled })).toBe(true);
  });

  it('sees a changed name, matcher or action', () => {
    expect(ruleEditsEqual(base, { ...base, name: 'Renamed' })).toBe(false);
    expect(
      ruleEditsEqual(base, {
        ...base,
        matcher: { ...base.matcher, url: { ...base.matcher.url, value: '/api/other' } },
      }),
    ).toBe(false);
    expect(ruleEditsEqual(base, { ...base, action: createHandlerAction('return 1;') })).toBe(false);
  });
});

describe('applyRuleEdits', () => {
  it('keeps the switch as it stands now, not as the draft remembers it', () => {
    // Someone disables the rule from the list while its form is open. Saving
    // the form must not put it back.
    const current = { ...createRule(1000, 'Users 404'), enabled: false, updatedAt: 5000 };
    const draft = { ...current, enabled: true, name: 'Renamed' };

    const saved = applyRuleEdits(current, draft);
    expect(saved.enabled).toBe(false);
    expect(saved.name).toBe('Renamed');
  });

  it('carries the edits and nothing else', () => {
    const current = createRule(1000, 'Users 404');
    const draft = { ...current, id: 'not_this', createdAt: 9, name: 'Renamed' };
    const saved = applyRuleEdits(current, draft);
    expect(saved.id).toBe(current.id);
    expect(saved.createdAt).toBe(current.createdAt);
    expect(saved.name).toBe('Renamed');
  });
});
