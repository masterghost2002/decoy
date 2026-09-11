/**
 * The tool surface an agent sees.
 *
 * Written against the same vocabulary as the UI — a rule is a matcher and an
 * action, position is priority, mocking has a master switch — because an agent
 * and a person working on the same rule set should not have to hold two
 * different models of it in their heads.
 *
 * Every tool returns text, not a blob of json, for the same reason the traffic
 * panel names the rule that decided a request: the useful answer to "did that
 * work?" is a sentence, and an agent reads one as readily as a person.
 */
import {
  AGENT_DEFAULT_PORT,
  CONDITION_OPERATORS,
  CONDITION_SOURCES,
  HTTP_METHODS,
  METHOD_ANY,
  NETWORK_ERROR_TYPES,
  STREAM_FORMATS,
  TRAFFIC_OUTCOMES,
  URL_MATCH_MODES,
  type AgentCommand,
} from '@decoy/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Bridge } from './bridge.js';

/* -------------------------------------------------------------------------- */
/* Shared input pieces                                                        */
/* -------------------------------------------------------------------------- */

const conditionShape = z.object({
  source: z.enum(CONDITION_SOURCES).describe('header, cookie, query, body, or jsonPath'),
  key: z
    .string()
    .optional()
    .describe('Header name, cookie name, query parameter, or a dotted json path like user.role'),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.string().optional().describe('Ignored by exists and notExists'),
  caseSensitive: z.boolean().optional(),
});

const ruleSpecShape = {
  url: z.string().describe('The url pattern. A bare path works with the default contains mode.'),
  name: z
    .string()
    .optional()
    .describe('Shown in the rule list. Generated from the rule if omitted.'),
  mode: z
    .enum(URL_MATCH_MODES)
    .optional()
    .describe(
      'contains (default) matches anywhere. equals, startsWith and wildcard are anchored to the whole url, so they need the host: 127.0.0.1:3000/api/users, not /api/users.',
    ),
  caseSensitive: z.boolean().optional(),
  methods: z
    .array(z.enum([METHOD_ANY, ...HTTP_METHODS]))
    .optional()
    .describe('Defaults to any method.'),
  conditions: z
    .array(conditionShape)
    .optional()
    .describe(
      'Narrows the rule beyond url and method: "this POST, but only when the payload says admin".',
    ),
  conditionMode: z.enum(['all', 'any']).optional(),
  enabled: z.boolean().optional().describe('Defaults to true.'),

  respond: z
    .object({
      status: z.number().int().min(200).max(599).optional(),
      statusText: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      json: z
        .unknown()
        .optional()
        .describe(
          'An object is serialized. A string is sent exactly as given, invalid json included.',
        ),
      text: z.string().optional(),
      delayMs: z.number().int().min(0).optional(),
    })
    .optional()
    .describe('Answer with a synthesized response.'),
  stream: z
    .object({
      chunks: z.array(z.unknown()).describe('One piece of the body per entry.'),
      format: z.enum(STREAM_FORMATS).optional().describe('sse (default), ndjson or text'),
      status: z.number().int().min(200).max(599).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      intervalMs: z.number().int().min(0).optional(),
      repeat: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0 never closes, for a long-lived event source.'),
      delayMs: z.number().int().min(0).optional(),
    })
    .optional()
    .describe('Answer a piece at a time, for progressive rendering or an event source.'),
  handler: z
    .object({
      code: z
        .string()
        .describe(
          'JavaScript with req, res, next, store in scope. `return res.status(201).json({...})`, or just `return { ok: true }`. Call next() to let the rules below answer instead.',
        ),
      timeoutMs: z.number().int().min(1).optional(),
      delayMs: z.number().int().min(0).optional(),
    })
    .optional()
    .describe('Answer with code, when the response depends on the request or on earlier calls.'),
  fail: z
    .object({
      type: z
        .enum(NETWORK_ERROR_TYPES)
        .optional()
        .describe(
          'failed rejects like a dead host, timeout never settles, aborted raises an AbortError.',
        ),
      delayMs: z.number().int().min(0).optional(),
    })
    .optional()
    .describe('Fail the request the way the network would.'),
  passthrough: z
    .literal(true)
    .optional()
    .describe(
      'Let it reach the real network. Place above a broader rule to carve out an exception.',
    ),
};

/* -------------------------------------------------------------------------- */
/* Formatting answers                                                         */
/* -------------------------------------------------------------------------- */

interface RuleSummary {
  id: string;
  index: number;
  name: string;
  enabled: boolean;
  url: string;
  mode: string;
  methods: string[];
  conditions: number;
  action: string;
  status?: number;
}

/** What `summarizeTraffic` sends back. Typed here so a line can be built from it. */
interface TrafficSummary {
  method: string;
  url: string;
  status: number | null;
  outcome: string;
  transport: string;
  ruleName: string | null;
}

function ruleLine(rule: RuleSummary): string {
  const position = String(rule.index + 1).padStart(2, '0');
  const methods = rule.methods.includes(METHOD_ANY) ? 'ANY' : rule.methods.join(',');
  const action = rule.status === undefined ? rule.action : `${rule.action} ${String(rule.status)}`;
  const extra = rule.conditions > 0 ? ` · ${String(rule.conditions)} condition(s)` : '';
  const off = rule.enabled ? '' : ' · OFF';
  return `${position}  ${rule.name}\n      ${methods} · ${rule.mode} ${rule.url} → ${action}${extra}${off}\n      id: ${rule.id}`;
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                  */
/* -------------------------------------------------------------------------- */

export function registerTools(server: McpServer, bridge: Bridge): void {
  const call = async (command: AgentCommand): Promise<Record<string, unknown>> =>
    (await bridge.call(command)) as Record<string, unknown>;

  server.registerTool(
    'decoy_status',
    {
      title: 'Decoy status',
      description:
        'Whether the browser is connected, whether mocking is on, and how many rules and requests there are. Start here when anything looks wrong.',
    },
    async () => {
      if (!bridge.connected && !(await bridge.waitForBrowser(2000))) {
        return text(
          [
            'No browser is connected.',
            '',
            'In Chrome: open Decoy, switch on Agent control, and check that',
            `the port is ${String(bridge.port)} and the token matches DECOY_TOKEN.`,
          ].join('\n'),
        );
      }
      const data = await call({ kind: 'status' });
      return text(
        [
          `Connected. Mocking is ${data['mocking'] === true ? 'on' : 'PAUSED'}.`,
          `${String(data['enabledRules'])} of ${String(data['rules'])} rules enabled.`,
          `${String(data['traffic'])} requests in the log.`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'decoy_list_rules',
    {
      title: 'List rules',
      description:
        'Every rule, in priority order. The first enabled rule that matches a request wins, so position 01 is checked first.',
    },
    async () => {
      const data = await call({ kind: 'rules.list' });
      const rules = (data['rules'] ?? []) as RuleSummary[];
      if (rules.length === 0) return text('No rules yet.');
      return text(
        [
          `${String(rules.length)} rule(s), in priority order. Mocking is ${data['mocking'] === true ? 'on' : 'PAUSED'}.`,
          '',
          ...rules.map(ruleLine),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'decoy_get_rule',
    {
      title: 'Get a rule',
      description: 'The whole of one rule, including its body and any conditions.',
      inputSchema: { id: z.string().describe('The rule id, from decoy_list_rules.') },
    },
    async ({ id }) => {
      const data = await call({ kind: 'rules.get', id });
      return text(JSON.stringify(data, null, 2));
    },
  );

  server.registerTool(
    'decoy_create_rule',
    {
      title: 'Create a rule',
      description:
        'Add a rule. It goes to the top by default, where it wins — position is the entire priority model. Give it exactly one of respond, stream, handler, fail or passthrough.',
      inputSchema: {
        ...ruleSpecShape,
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Where in the list to put it. 0 (the default) is the top, checked first.'),
      },
    },
    async ({ index, ...spec }) => {
      const data = await call({ kind: 'rules.create', spec, index });
      const rule = data['rule'] as RuleSummary;
      return text(`Created.\n\n${ruleLine(rule)}`);
    },
  );

  server.registerTool(
    'decoy_update_rule',
    {
      title: 'Update a rule',
      description:
        'Change part of a rule. Anything not mentioned is left as it is, so changing a status does not drop the url it matches on.',
      inputSchema: {
        id: z.string().describe('The rule id, from decoy_list_rules.'),
        ...Object.fromEntries(
          Object.entries(ruleSpecShape).map(([key, schema]) => [key, schema.optional()]),
        ),
      },
    },
    async ({ id, ...spec }) => {
      const data = await call({ kind: 'rules.update', id, spec });
      return text(`Updated.\n\n${ruleLine(data['rule'] as RuleSummary)}`);
    },
  );

  server.registerTool(
    'decoy_set_rule_enabled',
    {
      title: 'Switch a rule on or off',
      description:
        'A disabled rule is skipped entirely. Useful for seeing the real endpoint again without losing the rule.',
      inputSchema: { id: z.string(), enabled: z.boolean() },
    },
    async ({ id, enabled }) => {
      const data = await call({ kind: 'rules.enable', id, enabled });
      return text(
        `${enabled ? 'Enabled' : 'Disabled'}.\n\n${ruleLine(data['rule'] as RuleSummary)}`,
      );
    },
  );

  server.registerTool(
    'decoy_move_rule',
    {
      title: 'Reorder a rule',
      description:
        'Position is priority: the first enabled match wins. Move a rule up to make it beat a broader one above it.',
      inputSchema: { id: z.string(), index: z.number().int().min(0).describe('0 is the top.') },
    },
    async ({ id, index }) => {
      const data = await call({ kind: 'rules.move', id, index });
      return text(
        `Moved from position ${String((data['from'] as number) + 1)} to ${String((data['to'] as number) + 1)}.\n\n${ruleLine(data['rule'] as RuleSummary)}`,
      );
    },
  );

  server.registerTool(
    'decoy_delete_rule',
    {
      title: 'Delete a rule',
      description: 'Remove a rule for good. Switching it off is usually what you want instead.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      await call({ kind: 'rules.delete', id });
      return text(`Deleted ${id}.`);
    },
  );

  server.registerTool(
    'decoy_set_mocking',
    {
      title: 'Pause or resume all mocking',
      description:
        'The master switch. Paused means no rule is consulted at all, and every request reaches the network.',
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      await call({ kind: 'mocking.set', enabled });
      return text(
        enabled ? 'Mocking is on.' : 'Mocking is paused. Every request now reaches the network.',
      );
    },
  );

  server.registerTool(
    'decoy_which_rule_wins',
    {
      title: 'Which rule answers this url?',
      description:
        'Test a url against the rule set without making a request. Answers with the rule that wins, and what would answer if it were removed.',
      inputSchema: {
        url: z.string().describe('A full url, as the network panel shows it.'),
        method: z.string().optional().describe('Defaults to GET.'),
      },
    },
    async ({ url, method }) => {
      const data = await call({ kind: 'match.test', url, method });
      if (data['matched'] !== true) return text(`Nothing matches.\n${String(data['why'])}`);
      const next = data['next'] as RuleSummary | null;
      return text(
        [
          `${ruleLine(data['rule'] as RuleSummary)}`,
          '',
          next === null
            ? 'Nothing below it also matches, so removing it would let the request reach the network.'
            : `If that rule were removed or declined, this would answer instead:\n\n${ruleLine(next)}`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'decoy_list_traffic',
    {
      title: 'Recent requests',
      description:
        'What the page actually asked for, newest first, and which rule decided each one. Every request is logged, not only the mocked ones — which is how "my rule did not fire" gets answered.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Defaults to 50.'),
        outcome: z.enum(TRAFFIC_OUTCOMES).optional().describe('mocked, passthrough or failed'),
        urlContains: z.string().optional(),
      },
    },
    async ({ limit, outcome, urlContains }) => {
      const data = await call({ kind: 'traffic.list', limit, outcome, urlContains });
      const entries = (data['entries'] ?? []) as TrafficSummary[];
      if (entries.length === 0) {
        return text(
          'No matching requests. The log lives in the service worker and is emptied when Chrome shuts it down, so an empty log can also mean "not since the worker last restarted".',
        );
      }
      return text(
        [
          `${String(entries.length)} of ${String(data['total'])} logged request(s), newest first:`,
          '',
          ...entries.map((entry) => {
            const by = entry.ruleName === null ? 'no rule matched' : `by ${entry.ruleName}`;
            const status = entry.status === null ? '—' : String(entry.status);
            return `${entry.method} ${entry.url}\n      ${status} · ${entry.outcome} · ${by} · ${entry.transport}`;
          }),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'decoy_clear_traffic',
    {
      title: 'Clear the request log',
      description: 'Empties the traffic log. Rules are untouched.',
    },
    async () => {
      await call({ kind: 'traffic.clear' });
      return text('Cleared.');
    },
  );
}

export const DEFAULT_PORT = AGENT_DEFAULT_PORT;
