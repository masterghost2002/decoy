/**
 * `decoy-mcp` — the bridge between an agent and a browser running Decoy.
 *
 * Mocking an endpoint while an agent writes the code that calls it is the
 * obvious pairing: the agent already knows the shape it expects back, long
 * before the endpoint exists. This is how it says so.
 *
 * Run it from an MCP client's config:
 *
 *   {
 *     "mcpServers": {
 *       "decoy": {
 *         "command": "npx",
 *         "args": ["-y", "@decoy/mcp"],
 *         "env": { "DECOY_TOKEN": "<from the extension>" }
 *       }
 *     }
 *   }
 *
 * stdout belongs to the MCP transport, so every diagnostic goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AGENT_DEFAULT_PORT } from '@decoy/core';

import { Bridge, BridgeError } from './bridge.js';
import { registerTools } from './tools.js';

const log = (line: string): void => {
  process.stderr.write(`[decoy-mcp] ${line}\n`);
};

function readPort(): number {
  const raw = process.env['DECOY_PORT'];
  if (raw === undefined) return AGENT_DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    log(`DECOY_PORT=${raw} is not a usable port; falling back to ${String(AGENT_DEFAULT_PORT)}`);
    return AGENT_DEFAULT_PORT;
  }
  return port;
}

function readToken(): string {
  const token = process.env['DECOY_TOKEN'] ?? '';
  if (token.length === 0) {
    // Refusing is the only safe answer. An empty token would accept the first
    // thing that connected, on a port anything local can reach.
    log('');
    log('DECOY_TOKEN is not set, and the bridge will not run without one.');
    log('');
    log('Open Decoy in Chrome, switch on Agent control, copy the token it');
    log("shows, and put it in this server's env as DECOY_TOKEN.");
    log('');
    process.exit(2);
  }
  return token;
}

async function main(): Promise<void> {
  const bridge = new Bridge({ port: readPort(), token: readToken(), log });

  try {
    await bridge.listen();
  } catch (error) {
    if (error instanceof BridgeError) {
      log(error.message);
      if (error.hint !== undefined) log(error.hint);
      process.exit(1);
    }
    throw error;
  }

  const server = new McpServer(
    { name: 'decoy', version: '0.1.0' },
    {
      instructions: [
        'Decoy mocks browser requests without touching the app. Use it to stand in for an',
        'endpoint that does not exist yet, or to reproduce a failure the real API will not',
        'produce on demand.',
        '',
        'Two things decide everything:',
        '  - Rules are evaluated top to bottom and the first enabled match wins. To make a',
        '    rule beat another, move it up. There are no scores.',
        '  - A rule matches by url and method, and conditions narrow it further to a',
        '    particular call ("this POST, but only when the payload says admin").',
        '',
        'Start with decoy_status. If a rule seems not to fire, decoy_which_rule_wins says',
        'which one is answering instead, and decoy_list_traffic shows what the page really',
        'asked for.',
      ].join('\n'),
    },
  );

  registerTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready; waiting for a browser');

  const shutdown = (): void => {
    bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
