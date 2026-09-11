/**
 * The contract between Decoy and an agent driving it.
 *
 * Mocking an endpoint while an agent is building the code that calls it is the
 * obvious pairing: the agent knows the shape it expects back long before the
 * endpoint exists. What it needs is a way to say so — and the whole of that is
 * here, as data.
 *
 * Two decisions shape this file:
 *
 *  1. **The command logic is pure.** Everything except the transport is a
 *     function from a config and a command to a new config and an answer, so it
 *     is testable in node and cannot behave differently from the UI's own
 *     writes -- both end up in `loadConfig`.
 *  2. **An agent gets a friendlier rule than the UI does.** A `MockRule` has a
 *     nested matcher, an action union and ids to generate. `RuleSpec` is what
 *     someone would actually say -- "url contains /api/users, respond 404 with
 *     this json" -- and `ruleFromSpec` is the only place that translation
 *     happens.
 */
import type {
  ConditionMode,
  ConditionOperator,
  ConditionSource,
  RuleCondition,
} from './conditions.js';
import type { DecoyConfig } from './config.js';
import { decideRequest, findMatchingRuleFrom } from './engine.js';
import { DEFAULT_HANDLER_TIMEOUT_MS } from './handler.js';
import { METHOD_ANY, type MethodPattern } from './http.js';
import { createId } from './id.js';
import type { UrlMatchMode } from './matching.js';
import type {
  MockRule,
  NetworkErrorType,
  ResponseBody,
  ResponseHeader,
  RuleAction,
  StreamFormat,
} from './rule.js';
import type { TrafficEntry, TrafficOutcome } from './traffic.js';

/**
 * Bumped when a command or reply changes shape. The extension refuses a bridge
 * that does not match, because a half-understood command is worse than none:
 * an agent would be told its rule was written when it was not.
 */
export const AGENT_PROTOCOL_VERSION = 1;

/** Default port for the local bridge. Nothing well-known lives here. */
export const AGENT_DEFAULT_PORT = 8787;

/* -------------------------------------------------------------------------- */
/* The friendly rule shape                                                    */
/* -------------------------------------------------------------------------- */

export interface ConditionSpec {
  source: ConditionSource;
  /** Header name, cookie name, query parameter, or a dotted json path. */
  key?: string;
  operator: ConditionOperator;
  value?: string;
  caseSensitive?: boolean;
}

export interface RespondSpec {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  /** An object is serialized; a string is sent exactly as given. */
  json?: unknown;
  /** A text body. Mutually exclusive with `json`. */
  text?: string;
  delayMs?: number;
}

export interface StreamSpec {
  chunks: unknown[];
  format?: StreamFormat;
  status?: number;
  headers?: Record<string, string>;
  intervalMs?: number;
  /** 0 never closes, which is how a long-lived event source is mocked. */
  repeat?: number;
  delayMs?: number;
}

export interface HandlerSpec {
  code: string;
  timeoutMs?: number;
  delayMs?: number;
}

export interface FailSpec {
  type?: NetworkErrorType;
  delayMs?: number;
}

/**
 * What an agent says instead of building a `MockRule` by hand. Exactly one of
 * `respond` / `stream` / `handler` / `fail` / `passthrough` decides the action;
 * more than one is an error rather than a guess.
 */
export interface RuleSpec {
  name?: string;
  url: string;
  mode?: UrlMatchMode;
  caseSensitive?: boolean;
  methods?: MethodPattern[];
  conditions?: ConditionSpec[];
  conditionMode?: ConditionMode;
  enabled?: boolean;

  respond?: RespondSpec;
  stream?: StreamSpec;
  handler?: HandlerSpec;
  fail?: FailSpec;
  passthrough?: boolean;
}

function headerPairs(headers: Record<string, string> | undefined): ResponseHeader[] {
  if (headers === undefined) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/** An object becomes json text; a string is already the body the user meant. */
export function bodyText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Which action a spec asked for, or an explanation of why it is ambiguous. */
function actionFromSpec(spec: RuleSpec): { action: RuleAction } | { error: string } {
  const chosen: string[] = (['respond', 'stream', 'handler', 'fail'] as const).filter(
    (key) => spec[key] !== undefined,
  );
  if (spec.passthrough === true) chosen.push('passthrough');

  if (chosen.length === 0) {
    return {
      error:
        'The rule says nothing about what to answer with. Give it one of respond, stream, handler, fail or passthrough.',
    };
  }
  if (chosen.length > 1) {
    return {
      error: `A rule answers one way, but this one names ${String(chosen.length)}: ${chosen.join(', ')}.`,
    };
  }

  if (spec.passthrough === true) return { action: { kind: 'passthrough' } };

  if (spec.fail !== undefined) {
    return {
      action: {
        kind: 'networkError',
        errorType: spec.fail.type ?? 'failed',
        delayMs: spec.fail.delayMs ?? 0,
      },
    };
  }

  if (spec.handler !== undefined) {
    return {
      action: {
        kind: 'handler',
        code: spec.handler.code,
        delayMs: spec.handler.delayMs ?? 0,
        timeoutMs: spec.handler.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
      },
    };
  }

  if (spec.stream !== undefined) {
    return {
      action: {
        kind: 'stream',
        status: spec.stream.status ?? 200,
        statusText: '',
        headers: headerPairs(spec.stream.headers),
        format: spec.stream.format ?? 'sse',
        chunks: spec.stream.chunks.map((value) => ({
          id: createId('chunk'),
          value: bodyText(value),
        })),
        delayMs: spec.stream.delayMs ?? 0,
        intervalMs: spec.stream.intervalMs ?? 500,
        repeat: spec.stream.repeat ?? 1,
      },
    };
  }

  const respond = spec.respond ?? {};
  if (respond.json !== undefined && respond.text !== undefined) {
    return { error: 'A response has one body: give it json or text, not both.' };
  }

  const body: ResponseBody =
    respond.json !== undefined
      ? { type: 'json', value: bodyText(respond.json) }
      : respond.text !== undefined
        ? { type: 'text', value: respond.text }
        : { type: 'empty' };

  return {
    action: {
      kind: 'respond',
      status: respond.status ?? 200,
      statusText: respond.statusText ?? '',
      headers: headerPairs(respond.headers),
      body,
      delayMs: respond.delayMs ?? 0,
    },
  };
}

/** A spec, turned into the rule the rest of Decoy already understands. */
export function ruleFromSpec(spec: RuleSpec, now: number): { rule: MockRule } | { error: string } {
  if (typeof spec.url !== 'string' || spec.url.trim().length === 0) {
    return { error: 'A rule needs a url pattern; without one it can never match.' };
  }

  const built = actionFromSpec(spec);
  if ('error' in built) return built;

  const conditions: RuleCondition[] = (spec.conditions ?? []).map((condition) => ({
    id: createId('cond'),
    source: condition.source,
    key: condition.key ?? '',
    operator: condition.operator,
    value: condition.value ?? '',
    caseSensitive: condition.caseSensitive ?? false,
    enabled: true,
  }));

  return {
    rule: {
      id: createId('rule'),
      name: spec.name ?? describeSpec(spec),
      enabled: spec.enabled ?? true,
      matcher: {
        url: {
          mode: spec.mode ?? 'contains',
          value: spec.url,
          caseSensitive: spec.caseSensitive ?? false,
        },
        methods: spec.methods ?? [METHOD_ANY],
        conditions,
        conditionMode: spec.conditionMode ?? 'all',
      },
      action: built.action,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** A name for a rule that did not bring one, readable in the list. */
function describeSpec(spec: RuleSpec): string {
  const methods =
    spec.methods === undefined || spec.methods.includes(METHOD_ANY)
      ? ''
      : `${spec.methods.join('/')} `;
  if (spec.passthrough === true) return `Keep ${methods}${spec.url} real`;
  if (spec.fail !== undefined) return `Fail ${methods}${spec.url}`;
  if (spec.handler !== undefined) return `Handle ${methods}${spec.url}`;
  if (spec.stream !== undefined) return `Stream ${methods}${spec.url}`;
  return `Mock ${methods}${spec.url} ${String(spec.respond?.status ?? 200)}`;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export type AgentCommand =
  | { kind: 'status' }
  | { kind: 'rules.list' }
  | { kind: 'rules.get'; id: string }
  /** `index` places the rule; omitted means the top, where it wins. */
  | { kind: 'rules.create'; spec: RuleSpec; index?: number }
  | { kind: 'rules.update'; id: string; spec: Partial<RuleSpec> }
  | { kind: 'rules.delete'; id: string }
  | { kind: 'rules.enable'; id: string; enabled: boolean }
  | { kind: 'rules.move'; id: string; index: number }
  | { kind: 'mocking.set'; enabled: boolean }
  | { kind: 'traffic.list'; limit?: number; outcome?: TrafficOutcome; urlContains?: string }
  | { kind: 'traffic.clear' }
  | { kind: 'match.test'; url: string; method?: string };

export type AgentCommandKind = AgentCommand['kind'];

/** Commands that change the rule set, and so have to be written back. */
export const MUTATING_COMMANDS: ReadonlySet<AgentCommandKind> = new Set<AgentCommandKind>([
  'rules.create',
  'rules.update',
  'rules.delete',
  'rules.enable',
  'rules.move',
  'mocking.set',
]);

export interface AgentRequest {
  channel: 'decoy.agent.v1';
  kind: 'command';
  /** Correlates the reply; one socket carries every tool call. */
  id: string;
  command: AgentCommand;
}

export type AgentReply =
  | { channel: 'decoy.agent.v1'; kind: 'reply'; id: string; ok: true; data: unknown }
  | { channel: 'decoy.agent.v1'; kind: 'reply'; id: string; ok: false; error: string };

/** Sent by the extension as it connects, so the bridge can refuse a mismatch. */
export interface AgentHello {
  channel: 'decoy.agent.v1';
  kind: 'hello';
  version: number;
  token: string;
  /** Shown by the bridge so a person can tell which browser connected. */
  client: string;
}

export type AgentMessage = AgentRequest | AgentReply | AgentHello;

export const AGENT_CHANNEL = 'decoy.agent.v1';

function isAgentEnvelope(data: unknown): data is { channel: string; kind: string } {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return candidate['channel'] === AGENT_CHANNEL && typeof candidate['kind'] === 'string';
}

export function isAgentRequest(data: unknown): data is AgentRequest {
  return isAgentEnvelope(data) && data.kind === 'command';
}

export function isAgentReply(data: unknown): data is AgentReply {
  return isAgentEnvelope(data) && data.kind === 'reply';
}

export function isAgentHello(data: unknown): data is AgentHello {
  return isAgentEnvelope(data) && data.kind === 'hello';
}

/* -------------------------------------------------------------------------- */
/* Executing a command against a rule set                                     */
/* -------------------------------------------------------------------------- */

export type AgentResult =
  | { ok: false; error: string }
  /** `config` is present only when the command changed it. */
  | { ok: true; data: unknown; config?: DecoyConfig };

/** The shape a rule is reported in: enough to act on, not the whole object. */
export function summarizeRule(rule: MockRule, index: number): Record<string, unknown> {
  return {
    id: rule.id,
    index,
    name: rule.name,
    enabled: rule.enabled,
    url: rule.matcher.url.value,
    mode: rule.matcher.url.mode,
    methods: rule.matcher.methods,
    conditions: rule.matcher.conditions.length,
    action: rule.action.kind,
    status: 'status' in rule.action ? rule.action.status : undefined,
  };
}

function withRules(config: DecoyConfig, rules: MockRule[]): DecoyConfig {
  return { ...config, rules };
}

/**
 * Every command that only needs the rule set. Traffic lives in the service
 * worker's memory and is handled there; everything else is here, pure, and
 * shared by the tests and the worker alike.
 */
export function applyAgentCommand(
  config: DecoyConfig,
  command: AgentCommand,
  now: number,
): AgentResult {
  switch (command.kind) {
    case 'rules.list':
      return {
        ok: true,
        data: { rules: config.rules.map(summarizeRule), mocking: config.enabled },
      };

    case 'rules.get': {
      const index = config.rules.findIndex((rule) => rule.id === command.id);
      const rule = config.rules[index];
      if (rule === undefined) return { ok: false, error: `No rule with id ${command.id}.` };
      return { ok: true, data: { ...rule, index } };
    }

    case 'rules.create': {
      const built = ruleFromSpec(command.spec, now);
      if ('error' in built) return { ok: false, error: built.error };
      const rules = [...config.rules];
      // Default to the top. Position is the whole priority model, and a new
      // rule that lands under an existing broad one looks like it did nothing.
      const at = clampIndex(command.index ?? 0, rules.length);
      rules.splice(at, 0, built.rule);
      return {
        ok: true,
        data: { rule: summarizeRule(built.rule, at) },
        config: withRules(config, rules),
      };
    }

    case 'rules.update': {
      const index = config.rules.findIndex((rule) => rule.id === command.id);
      const existing = config.rules[index];
      if (existing === undefined) return { ok: false, error: `No rule with id ${command.id}.` };

      // Merged against what the rule already says, so an update naming only a
      // status does not silently drop the url it was matching on.
      const merged = specFromRule(existing);
      const built = ruleFromSpec({ ...merged, ...command.spec }, now);
      if ('error' in built) return { ok: false, error: built.error };

      const rules = [...config.rules];
      rules[index] = {
        ...built.rule,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      return {
        ok: true,
        data: { rule: summarizeRule(rules[index], index) },
        config: withRules(config, rules),
      };
    }

    case 'rules.delete': {
      const rules = config.rules.filter((rule) => rule.id !== command.id);
      if (rules.length === config.rules.length) {
        return { ok: false, error: `No rule with id ${command.id}.` };
      }
      return { ok: true, data: { deleted: command.id }, config: withRules(config, rules) };
    }

    case 'rules.enable': {
      const index = config.rules.findIndex((rule) => rule.id === command.id);
      const existing = config.rules[index];
      if (existing === undefined) return { ok: false, error: `No rule with id ${command.id}.` };
      const rules = [...config.rules];
      rules[index] = { ...existing, enabled: command.enabled, updatedAt: now };
      return {
        ok: true,
        data: { rule: summarizeRule(rules[index], index) },
        config: withRules(config, rules),
      };
    }

    case 'rules.move': {
      const from = config.rules.findIndex((rule) => rule.id === command.id);
      const existing = config.rules[from];
      if (existing === undefined) return { ok: false, error: `No rule with id ${command.id}.` };
      const rules = [...config.rules];
      rules.splice(from, 1);
      const to = clampIndex(command.index, rules.length);
      rules.splice(to, 0, existing);
      return {
        ok: true,
        data: { rule: summarizeRule(existing, to), from, to },
        config: withRules(config, rules),
      };
    }

    case 'mocking.set':
      return {
        ok: true,
        data: { mocking: command.enabled },
        config: { ...config, enabled: command.enabled },
      };

    case 'match.test': {
      const method = command.method ?? 'GET';
      const decision = decideRequest(config, { url: command.url, method });
      if (decision === null) {
        return {
          ok: true,
          data: {
            matched: false,
            // The honest reason, which is one of two quite different things.
            why: config.enabled
              ? 'No enabled rule matches this url and method.'
              : 'Mocking is paused, so no rule is consulted at all.',
          },
        };
      }
      return {
        ok: true,
        data: {
          matched: true,
          rule: summarizeRule(decision.rule, decision.index),
          action: decision.plan.kind,
          // What would answer it next, if this rule were removed or declined.
          next: nextMatchAfter(config, command.url, method, decision.index),
        },
      };
    }

    default:
      return {
        ok: false,
        error: `${command.kind} is not handled here.`,
      };
  }
}

function nextMatchAfter(
  config: DecoyConfig,
  url: string,
  method: string,
  index: number,
): Record<string, unknown> | null {
  const found = findMatchingRuleFrom(config, { url, method }, index + 1);
  return found === null ? null : summarizeRule(found.rule, found.index);
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length);
}

/**
 * A stored rule, back in the shape an update is written in.
 *
 * Only used to merge a partial update, which is why it is allowed to be lossy
 * in one direction: condition ids are regenerated, and that is fine, because a
 * condition is identified by what it says rather than by its id.
 */
export function specFromRule(rule: MockRule): RuleSpec {
  const spec: RuleSpec = {
    name: rule.name,
    url: rule.matcher.url.value,
    mode: rule.matcher.url.mode,
    caseSensitive: rule.matcher.url.caseSensitive,
    methods: rule.matcher.methods,
    conditionMode: rule.matcher.conditionMode,
    enabled: rule.enabled,
    conditions: rule.matcher.conditions
      .filter((condition) => condition.enabled)
      .map((condition) => ({
        source: condition.source,
        key: condition.key,
        operator: condition.operator,
        value: condition.value,
        caseSensitive: condition.caseSensitive,
      })),
  };

  const action = rule.action;
  if (action.kind === 'passthrough') return { ...spec, passthrough: true };
  if (action.kind === 'networkError') {
    return { ...spec, fail: { type: action.errorType, delayMs: action.delayMs } };
  }
  if (action.kind === 'handler') {
    return {
      ...spec,
      handler: { code: action.code, timeoutMs: action.timeoutMs, delayMs: action.delayMs },
    };
  }
  if (action.kind === 'stream') {
    return {
      ...spec,
      stream: {
        chunks: action.chunks.map((chunk) => chunk.value),
        format: action.format,
        status: action.status,
        headers: Object.fromEntries(action.headers.map((header) => [header.name, header.value])),
        intervalMs: action.intervalMs,
        repeat: action.repeat,
        delayMs: action.delayMs,
      },
    };
  }

  return {
    ...spec,
    respond: {
      status: action.status,
      statusText: action.statusText,
      headers: Object.fromEntries(action.headers.map((header) => [header.name, header.value])),
      ...(action.body.type === 'json'
        ? { json: action.body.value }
        : action.body.type === 'text'
          ? { text: action.body.value }
          : {}),
      delayMs: action.delayMs,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Traffic, which the worker owns                                             */
/* -------------------------------------------------------------------------- */

/** The shape a request is reported in. The full entry is far too much to read. */
export function summarizeTraffic(entry: TrafficEntry): Record<string, unknown> {
  return {
    id: entry.id,
    at: entry.startedAt,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    outcome: entry.outcome,
    transport: entry.transport,
    ruleId: entry.ruleId,
    ruleName: entry.ruleName,
    durationMs: entry.durationMs,
  };
}

export function filterTraffic(
  entries: readonly TrafficEntry[],
  query: { limit?: number; outcome?: TrafficOutcome; urlContains?: string },
): TrafficEntry[] {
  const needle = query.urlContains?.toLowerCase();
  const matched = entries.filter((entry) => {
    if (query.outcome !== undefined && entry.outcome !== query.outcome) return false;
    if (needle !== undefined && !entry.url.toLowerCase().includes(needle)) return false;
    return true;
  });
  // Newest first is how the log is already ordered, so a limit means "the most
  // recent N", which is what anyone asking for 20 wants.
  return matched.slice(0, Math.max(1, Math.min(query.limit ?? 50, 500)));
}
