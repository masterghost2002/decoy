import { describe, expect, it } from 'vitest';

import { resolveAction, type RespondPlan } from '../resolve.js';
import type { RespondAction, RuleAction } from '../rule.js';

function respond(overrides: Partial<RespondAction> = {}): RespondAction {
  return {
    kind: 'respond',
    status: 200,
    statusText: '',
    headers: [],
    body: { type: 'json', value: '{"ok":true}' },
    delayMs: 0,
    ...overrides,
  };
}

function asRespond(action: RuleAction): RespondPlan {
  const plan = resolveAction(action);
  if (plan.kind !== 'respond') throw new Error(`expected a respond plan, got ${plan.kind}`);
  return plan;
}

function headerValue(plan: RespondPlan, name: string): string | undefined {
  return plan.headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

describe('resolveAction for respond', () => {
  it('fills in the conventional reason phrase when none is given', () => {
    expect(asRespond(respond({ status: 503 })).statusText).toBe('Service Unavailable');
    expect(asRespond(respond({ status: 599 })).statusText).toBe('');
  });

  it('keeps an explicit reason phrase', () => {
    expect(asRespond(respond({ status: 404, statusText: 'Gone Fishing' })).statusText).toBe(
      'Gone Fishing',
    );
  });

  it('defaults the content type from the body type', () => {
    expect(headerValue(asRespond(respond()), 'content-type')).toBe('application/json');
    expect(
      headerValue(asRespond(respond({ body: { type: 'text', value: 'hi' } })), 'content-type'),
    ).toBe('text/plain;charset=utf-8');
  });

  it('never overrides a content type the rule set itself', () => {
    const plan = asRespond(
      respond({ headers: [{ name: 'Content-Type', value: 'application/problem+json' }] }),
    );
    expect(plan.headers.filter(([name]) => name.toLowerCase() === 'content-type')).toHaveLength(1);
    expect(headerValue(plan, 'content-type')).toBe('application/problem+json');
  });

  it('drops blank header names but preserves order and duplicates', () => {
    const plan = asRespond(
      respond({
        body: { type: 'empty' },
        headers: [
          { name: 'Set-Cookie', value: 'a=1' },
          { name: '   ', value: 'ignored' },
          { name: 'Set-Cookie', value: 'b=2' },
        ],
      }),
    );
    expect(plan.headers).toEqual([
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
  });

  it('sends no body, and no content type, for an empty body', () => {
    const plan = asRespond(respond({ body: { type: 'empty' } }));
    expect(plan.body).toBeNull();
    expect(headerValue(plan, 'content-type')).toBeUndefined();
  });

  it('drops the body on statuses that forbid one', () => {
    expect(asRespond(respond({ status: 204 })).body).toBeNull();
    expect(asRespond(respond({ status: 304 })).body).toBeNull();
    expect(asRespond(respond({ status: 200 })).body).toBe('{"ok":true}');
  });

  it('passes a malformed body through untouched, since that is a case worth mocking', () => {
    const broken = '{"unterminated": ';
    expect(asRespond(respond({ body: { type: 'json', value: broken } })).body).toBe(broken);
  });

  it('clamps a negative delay to zero', () => {
    expect(asRespond(respond({ delayMs: -5 })).delayMs).toBe(0);
  });
});

describe('resolveAction for the other kinds', () => {
  it('passes network errors through with a clamped delay', () => {
    expect(resolveAction({ kind: 'networkError', errorType: 'timeout', delayMs: -1 })).toEqual({
      kind: 'networkError',
      errorType: 'timeout',
      delayMs: 0,
    });
  });

  it('resolves passthrough to a passthrough plan', () => {
    expect(resolveAction({ kind: 'passthrough' })).toEqual({ kind: 'passthrough' });
  });
});
