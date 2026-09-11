# @decoy/mcp

Drive Decoy from an agent, so it can mock an endpoint while it writes the code
that calls it.

The pairing is the obvious one: an agent building a feature already knows the
shape it expects back, long before the endpoint exists. This is how it says so —
and how it reads back what the page actually asked for when the answer turns out
to be wrong.

## Setting it up

1. **In Chrome:** open Decoy, press the agent button in the header, switch
   **Agent control** on, and copy the configuration block it shows. The token in
   it is this browser's.
2. **In your agent:** paste that block into the MCP client's config.

```json
{
  "mcpServers": {
    "decoy": {
      "command": "npx",
      "args": ["-y", "@decoy/mcp"],
      "env": { "DECOY_TOKEN": "…", "DECOY_PORT": "8787" }
    }
  }
}
```

Ask the agent for `decoy_status` to check both halves are talking.

## How it is wired

```
agent  ──stdio/MCP──▶  decoy-mcp  ◀──WebSocket──  Chrome service worker
                       127.0.0.1                   (dials out; never listens)
```

The direction is forced and turns out to be the right one anyway. An MV3 service
worker cannot listen for connections — but it can open one, so the browser
decides what it talks to rather than accepting whatever arrives. An open socket
also resets the worker's idle timer, which quietly solves the other MV3 problem:
a worker that goes to sleep mid-conversation.

Three things guard it:

- **Off by default**, and switched on in the extension. The side granting
  permission is the side that mints the secret.
- **Loopback only.** There is no case where the agent and the browser are on
  different machines, so there is no reason to be reachable from one.
- **A token on every connection.** A mismatch is closed with 4401, which the
  extension reads as "stop retrying and say why" rather than flapping.

## Tools

| Tool | What it does |
| --- | --- |
| `decoy_status` | Is the browser connected, is mocking on, how many rules and requests. Start here. |
| `decoy_list_rules` | Every rule, in priority order — the order they are checked in |
| `decoy_get_rule` | One rule in full, body and conditions included |
| `decoy_create_rule` | Add a rule. Goes to the top, where it wins |
| `decoy_update_rule` | Change part of a rule; anything unmentioned is left alone |
| `decoy_set_rule_enabled` | Switch a rule off without losing it |
| `decoy_move_rule` | Reorder. Position *is* priority |
| `decoy_delete_rule` | Remove a rule for good |
| `decoy_set_mocking` | The master switch |
| `decoy_which_rule_wins` | Which rule answers a url, and what would answer if it were gone |
| `decoy_list_traffic` | What the page really asked for, and which rule decided each one |
| `decoy_clear_traffic` | Empty the log |

A rule is described the way someone would say it, not the way it is stored:

```json
{
  "url": "/api/users",
  "methods": ["GET"],
  "respond": { "status": 200, "json": { "items": [] } }
}
```

`respond`, `stream`, `handler`, `fail` and `passthrough` are the five ways to
answer, and a rule names exactly one. Naming none or naming two is an error
rather than a guess.

## Why the answers are sentences

Every tool returns text. The useful answer to "did that work?" is a sentence,
and an agent reads one as readily as a person does — so `decoy_which_rule_wins`
says which rule answered *and* what would answer if it were removed, and an
empty traffic log explains that the worker may simply have restarted rather than
letting "no requests" stand for two quite different things.

## Development

```bash
pnpm --filter @decoy/mcp build      # bundles dist/main.js and dist/bridge.js
pnpm --filter @decoy/mcp test       # the bridge protocol, against a stub extension
pnpm e2e                                # the real worker, over the real socket
```

The protocol lives in `packages/core/src/agent.ts`, and so does every command's
effect on a rule set — pure, and unit-tested in node. This package is transport
and phrasing; the extension is transport and storage. Neither holds logic the
other could disagree with.
