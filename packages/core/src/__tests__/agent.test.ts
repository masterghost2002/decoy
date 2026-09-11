import { describe, expect, it } from 'vitest';

import {
  applyAgentCommand,
  filterTraffic,
  ruleFromSpec,
  specFromRule,
  summarizeRule,
  type RuleSpec,
} from '../agent.js';
import { createDefaultConfig, type DecoyConfig } from '../config.js';
import type { MockRule } from '../rule.js';
import type { TrafficEntry } from '../traffic.js';
import { parseAgentCommand } from '../schema.js';

const NOW = 1_700_000_000_000;

function build(spec: RuleSpec): MockRule {
  const result = ruleFromSpec(spec, NOW);
  if ('error' in result) throw new Error(result.error);
  return result.rule;
}

function configWith(...specs: RuleSpec[]): DecoyConfig {
  return { ...createDefaultConfig(), rules: specs.map(build) };
}

/** Ids are generated per call, so they are never what a comparison is about. */
function withoutChunkIds(action: MockRule['action']): unknown {
  if (action.kind !== 'stream') return action;
  return { ...action, chunks: action.chunks.map((chunk) => chunk.value) };
}

describe('ruleFromSpec', () => {
  it('turns the shortest useful spec into a complete rule', () => {
    const rule = build({ url: '/api/users', respond: { status: 404 } });
    expect(rule.matcher.url).toEqual({
      mode: 'contains',
      value: '/api/users',
      caseSensitive: false,
    });
    expect(rule.matcher.methods).toEqual(['*']);
    expect(rule.action).toMatchObject({ kind: 'respond', status: 404, body: { type: 'empty' } });
    expect(rule.enabled).toBe(true);
  });

  it('serializes an object body and leaves a string one alone', () => {
    expect(build({ url: '/a', respond: { json: { ok: true } } }).action).toMatchObject({
      body: { type: 'json', value: '{\n  "ok": true\n}' },
    });
    // A deliberately malformed body is a legitimate thing to mock, so a string
    // is never reformatted on the way through.
    expect(build({ url: '/a', respond: { json: '{"broken":' } }).action).toMatchObject({
      body: { type: 'json', value: '{"broken":' },
    });
  });

  it('names a rule that did not bring a name', () => {
    expect(build({ url: '/api/users', respond: { status: 404 } }).name).toBe('Mock /api/users 404');
    expect(build({ url: '/api/users', passthrough: true }).name).toBe('Keep /api/users real');
    expect(build({ url: '/x', methods: ['POST'], fail: {} }).name).toBe('Fail POST /x');
  });

  it('refuses a spec that says nothing about what to answer with', () => {
    const result = ruleFromSpec({ url: '/a' }, NOW);
    expect(result).toHaveProperty('error');
    if ('error' in result) expect(result.error).toContain('respond, stream, handler, fail');
  });

  it('refuses a spec that answers two ways at once', () => {
    const result = ruleFromSpec({ url: '/a', respond: {}, passthrough: true }, NOW);
    expect(result).toHaveProperty('error');
    if ('error' in result) expect(result.error).toContain('names 2');
  });

  it('refuses a rule with no url, because it could never match', () => {
    const result = ruleFromSpec({ url: '   ', respond: {} }, NOW);
    expect(result).toHaveProperty('error');
  });

  it('round-trips through specFromRule without losing the action', () => {
    for (const spec of [
      { url: '/a', respond: { status: 201, json: '{"a":1}', headers: { 'X-A': '1' } } },
      { url: '/b', stream: { chunks: ['one', 'two'], format: 'ndjson' as const, repeat: 0 } },
      { url: '/c', handler: { code: 'return { ok: true };' } },
      { url: '/d', fail: { type: 'timeout' as const } },
      { url: '/e', passthrough: true },
    ] satisfies RuleSpec[]) {
      const rule = build(spec);
      const back = build(specFromRule(rule));
      // Chunk ids are regenerated on the way back, which is fine: a chunk is
      // identified by its position and its value, never by its id.
      expect(withoutChunkIds(back.action)).toEqual(withoutChunkIds(rule.action));
      expect(back.matcher).toEqual(rule.matcher);
    }
  });
});

describe('applyAgentCommand', () => {
  it('creates at the top by default, because position is the priority model', () => {
    const config = configWith({ name: 'broad', url: '/api', respond: {} });
    const result = applyAgentCommand(
      config,
      {
        kind: 'rules.create',
        spec: { name: 'narrow', url: '/api/users', respond: { status: 404 } },
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config?.rules[0]?.name).toBe('narrow');
    expect(result.config?.rules).toHaveLength(2);
  });

  it('honours an explicit index, and clamps one past the end', () => {
    const config = configWith(
      { name: 'a', url: '/a', respond: {} },
      { name: 'b', url: '/b', respond: {} },
    );
    const result = applyAgentCommand(
      config,
      { kind: 'rules.create', spec: { name: 'c', url: '/c', respond: {} }, index: 99 },
      NOW,
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.config?.rules.map((rule) => rule.name)).toEqual(['a', 'b', 'c']);
  });

  it('merges an update against what the rule already says', () => {
    const config = configWith({
      name: 'users',
      url: '/api/users',
      methods: ['GET'],
      respond: { status: 200 },
    });
    const id = config.rules[0]!.id;
    const result = applyAgentCommand(
      config,
      { kind: 'rules.update', id, spec: { respond: { status: 503 } } },
      NOW,
    );
    if (!result.ok) throw new Error('expected success');

    const updated = result.config!.rules[0]!;
    // The url and method were not mentioned, so they must survive.
    expect(updated.matcher.url.value).toBe('/api/users');
    expect(updated.matcher.methods).toEqual(['GET']);
    expect(updated.action).toMatchObject({ status: 503 });
    // The identity survives too, or every update would look like a new rule.
    expect(updated.id).toBe(id);
    expect(updated.createdAt).toBe(config.rules[0]!.createdAt);
  });

  it('moves a rule and reports where it went', () => {
    const config = configWith(
      { name: 'a', url: '/a', respond: {} },
      { name: 'b', url: '/b', respond: {} },
      { name: 'c', url: '/c', respond: {} },
    );
    const result = applyAgentCommand(
      config,
      { kind: 'rules.move', id: config.rules[2]!.id, index: 0 },
      NOW,
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.config?.rules.map((rule) => rule.name)).toEqual(['c', 'a', 'b']);
    expect(result.data).toMatchObject({ from: 2, to: 0 });
  });

  it('reports a missing rule by id rather than doing nothing', () => {
    for (const command of [
      { kind: 'rules.get' as const, id: 'nope' },
      { kind: 'rules.delete' as const, id: 'nope' },
      { kind: 'rules.enable' as const, id: 'nope', enabled: false },
      { kind: 'rules.move' as const, id: 'nope', index: 0 },
    ]) {
      const result = applyAgentCommand(configWith({ url: '/a', respond: {} }), command, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('nope');
    }
  });

  it('answers which rule wins, and what would answer next', () => {
    const config = configWith(
      { name: 'first', url: '/api/users', respond: { status: 404 } },
      { name: 'second', url: '/api', respond: { status: 200 } },
    );
    const result = applyAgentCommand(
      config,
      { kind: 'match.test', url: 'https://x.test/api/users' },
      NOW,
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.data).toMatchObject({
      matched: true,
      rule: { name: 'first' },
      next: { name: 'second' },
    });
  });

  it('distinguishes "nothing matches" from "mocking is paused"', () => {
    const config = configWith({ url: '/api', respond: {} });
    const nothing = applyAgentCommand(
      config,
      { kind: 'match.test', url: 'https://x.test/other' },
      NOW,
    );
    const paused = applyAgentCommand(
      { ...config, enabled: false },
      { kind: 'match.test', url: 'https://x.test/api' },
      NOW,
    );
    expect((nothing as { data: { why: string } }).data.why).toContain('No enabled rule');
    expect((paused as { data: { why: string } }).data.why).toContain('paused');
  });

  it('leaves the config alone for a read-only command', () => {
    const config = configWith({ url: '/a', respond: {} });
    const result = applyAgentCommand(config, { kind: 'rules.list' }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toBeUndefined();
  });
});

describe('summarizeRule', () => {
  it('reports the fields an agent acts on, not the whole rule', () => {
    const rule = build({
      name: 'users',
      url: '/api/users',
      methods: ['GET'],
      respond: { status: 404 },
    });
    expect(summarizeRule(rule, 3)).toMatchObject({
      index: 3,
      name: 'users',
      url: '/api/users',
      mode: 'contains',
      action: 'respond',
      status: 404,
    });
  });
});

describe('filterTraffic', () => {
  const entry = (over: Partial<TrafficEntry>): TrafficEntry =>
    ({
      id: 'x',
      url: 'https://x.test/api/users',
      method: 'GET',
      outcome: 'mocked',
      transport: 'fetch',
      startedAt: 0,
      ...over,
    }) as TrafficEntry;

  it('filters by outcome and by url, and caps the count', () => {
    const entries = [
      entry({ id: '1', outcome: 'mocked' }),
      entry({ id: '2', outcome: 'passthrough', url: 'https://x.test/api/ping' }),
      entry({ id: '3', outcome: 'failed' }),
    ];
    expect(filterTraffic(entries, { outcome: 'passthrough' }).map((e) => e.id)).toEqual(['2']);
    expect(filterTraffic(entries, { urlContains: 'PING' }).map((e) => e.id)).toEqual(['2']);
    expect(filterTraffic(entries, { limit: 1 })).toHaveLength(1);
  });
});

describe('parseAgentCommand', () => {
  it('accepts a well-formed command', () => {
    const result = parseAgentCommand({
      kind: 'rules.create',
      spec: { url: '/a', respond: { status: 200 } },
    });
    expect(result.ok).toBe(true);
  });

  it('names the field that was wrong, in a sentence', () => {
    const result = parseAgentCommand({ kind: 'rules.create', spec: { respond: {} } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spec.url');
  });

  it('refuses a status the platform could not construct', () => {
    const result = parseAgentCommand({
      kind: 'rules.create',
      spec: { url: '/a', respond: { status: 100 } },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a command it does not know', () => {
    expect(parseAgentCommand({ kind: 'rules.nuke' }).ok).toBe(false);
    expect(parseAgentCommand('rules.list').ok).toBe(false);
  });
});
