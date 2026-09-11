import { describe, expect, it } from 'vitest';

import { resolveAction, type RespondPlan, type StreamPlan } from '../resolve.js';
import type { RespondAction, RuleAction, StreamAction } from '../rule.js';

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

describe('resolveAction for stream', () => {
  const stream = (overrides: Partial<StreamAction> = {}): StreamAction => ({
    kind: 'stream',
    status: 200,
    statusText: '',
    headers: [],
    format: 'sse',
    chunks: [{ id: 'c1', value: '{"n":1}' }],
    delayMs: 0,
    intervalMs: 500,
    repeat: 1,
    ...overrides,
  });

  function asStream(action: RuleAction): StreamPlan {
    const plan = resolveAction(action);
    if (plan.kind !== 'stream') throw new Error(`expected a stream plan, got ${plan.kind}`);
    return plan;
  }

  it('defaults the content type from the format', () => {
    expect(asStream(stream()).headers).toContainEqual(['content-type', 'text/event-stream']);
    expect(asStream(stream({ format: 'ndjson' })).headers).toContainEqual([
      'content-type',
      'application/x-ndjson',
    ]);
    expect(asStream(stream({ format: 'text' })).headers).toContainEqual([
      'content-type',
      'text/plain;charset=utf-8',
    ]);
  });

  it('never overrides a content type the rule set itself', () => {
    const plan = asStream(
      stream({ headers: [{ name: 'Content-Type', value: 'text/event-stream; charset=utf-8' }] }),
    );
    expect(plan.headers.filter(([name]) => name.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('wraps a bare sse payload in a data field and terminates the event', () => {
    expect(asStream(stream()).chunks).toEqual(['data: {"n":1}\n\n']);
  });

  it('leaves a chunk that already names an sse field alone', () => {
    const plan = asStream(stream({ chunks: [{ id: 'c1', value: 'event: ping\ndata: {}' }] }));
    expect(plan.chunks).toEqual(['event: ping\ndata: {}\n\n']);
  });

  it('prefixes every line of a multi-line sse payload', () => {
    const plan = asStream(stream({ chunks: [{ id: 'c1', value: 'one\ntwo' }] }));
    expect(plan.chunks).toEqual(['data: one\ndata: two\n\n']);
  });

  it('compacts pretty-printed json onto one ndjson line', () => {
    const plan = asStream(
      stream({ format: 'ndjson', chunks: [{ id: 'c1', value: '{\n  "n": 1\n}' }] }),
    );
    expect(plan.chunks).toEqual(['{"n":1}\n']);
  });

  it('sends text chunks exactly as written, with no separator', () => {
    const plan = asStream(stream({ format: 'text', chunks: [{ id: 'c1', value: 'half a ' }] }));
    expect(plan.chunks).toEqual(['half a ']);
  });

  it('drops chunks that would put nothing on the wire', () => {
    const plan = asStream(
      stream({
        chunks: [
          { id: 'c1', value: '  ' },
          { id: 'c2', value: 'x' },
        ],
      }),
    );
    expect(plan.chunks).toEqual(['data: x\n\n']);
  });

  it('drops every chunk on a status that cannot carry a body', () => {
    expect(asStream(stream({ status: 204 })).chunks).toEqual([]);
  });

  it('fills in the conventional reason phrase, like respond does', () => {
    expect(asStream(stream({ status: 503 })).statusText).toBe('Service Unavailable');
  });

  it('keeps zero repeats as the never-ending sentinel', () => {
    expect(asStream(stream({ repeat: 0 })).repeat).toBe(0);
  });

  it('clamps negative timings and repeats', () => {
    const plan = asStream(stream({ delayMs: -5, intervalMs: -1, repeat: -3 }));
    expect(plan).toMatchObject({ delayMs: 0, intervalMs: 0, repeat: 0 });
  });
});
