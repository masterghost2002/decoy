import {
  AGENT_CHANNEL,
  AGENT_PROTOCOL_VERSION,
  isAgentRequest,
  type AgentReply,
} from '@decoy/core';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { Bridge, BridgeError } from '../bridge.js';

/**
 * The bridge is the one piece with no pure core to lean on: it is a socket, a
 * handshake and a correlation table. So these tests run the real server against
 * a stub that behaves the way the extension does — including the ways it
 * misbehaves.
 */

const TOKEN = 'a-token-for-the-tests';
/** Above the usual range, so a developer's own bridge cannot collide with it. */
let nextPort = 18_900;

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function startBridge(token = TOKEN): Promise<Bridge> {
  // A short wait: these tests assert on the give-up path, and five real
  // seconds of it per case is five seconds of CI nobody learns anything from.
  const bridge = new Bridge({ port: (nextPort += 1), token, connectWaitMs: 200 });
  await bridge.listen();
  cleanups.push(() => {
    bridge.close();
  });
  return bridge;
}

/** A stand-in for the extension: says hello, then answers whatever it is asked. */
function connectStub(
  bridge: Bridge,
  options: {
    token?: string;
    version?: number;
    answer?: (command: {
      kind: string;
    }) => { ok: true; data: unknown } | { ok: false; error: string };
  } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(bridge.port)}`);
  cleanups.push(() => {
    socket.close();
  });

  return new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          channel: AGENT_CHANNEL,
          kind: 'hello',
          version: options.version ?? AGENT_PROTOCOL_VERSION,
          token: options.token ?? TOKEN,
          client: 'stub',
        }),
      );
      resolve(socket);
    });
    socket.on('message', (raw: Buffer) => {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!isAgentRequest(parsed)) return;
      const outcome = options.answer?.(parsed.command) ?? {
        ok: true as const,
        data: { echoed: parsed.command.kind },
      };
      const reply: AgentReply = {
        channel: AGENT_CHANNEL,
        kind: 'reply',
        id: parsed.id,
        ...outcome,
      };
      socket.send(JSON.stringify(reply));
    });
  });
}

const closedWith = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => {
    socket.on('close', (code) => resolve(code));
  });

describe('Bridge', () => {
  it('carries a command to the browser and brings the answer back', async () => {
    const bridge = await startBridge();
    await connectStub(bridge);
    await bridge.waitForBrowser();

    await expect(bridge.call({ kind: 'rules.list' })).resolves.toEqual({ echoed: 'rules.list' });
  });

  it('turns a refusal from the browser into an error, not a silent success', async () => {
    const bridge = await startBridge();
    await connectStub(bridge, {
      answer: () => ({ ok: false, error: 'No rule with id nope.' }),
    });
    await bridge.waitForBrowser();

    await expect(bridge.call({ kind: 'rules.get', id: 'nope' })).rejects.toThrow(
      'No rule with id nope.',
    );
  });

  it('closes a connection with the wrong token, and stays unconnected', async () => {
    const bridge = await startBridge();
    const socket = await connectStub(bridge, { token: 'wrong' });

    // 4401 is the code the extension reads to stop retrying and say why.
    await expect(closedWith(socket)).resolves.toBe(4401);
    expect(bridge.connected).toBe(false);
  });

  it('closes a connection speaking a different protocol version', async () => {
    const bridge = await startBridge();
    const socket = await connectStub(bridge, { version: AGENT_PROTOCOL_VERSION + 99 });
    await expect(closedWith(socket)).resolves.toBe(4426);
  });

  it('ignores a command from a socket that never said hello', async () => {
    const bridge = await startBridge();
    const socket = new WebSocket(`ws://127.0.0.1:${String(bridge.port)}`);
    cleanups.push(() => {
      socket.close();
    });
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(
      JSON.stringify({ channel: AGENT_CHANNEL, kind: 'reply', id: 'x', ok: true, data: 1 }),
    );

    // Nothing was authenticated, so nothing is connected, and a call has to
    // fail rather than be answered by an unauthenticated peer.
    expect(bridge.connected).toBe(false);
    await expect(bridge.call({ kind: 'status' })).rejects.toThrow(BridgeError);
  });

  it('lets the newest browser win, and tells the older one why', async () => {
    const bridge = await startBridge();
    const first = await connectStub(bridge);
    await bridge.waitForBrowser();

    const superseded = closedWith(first);
    await connectStub(bridge);
    await expect(superseded).resolves.toBe(4409);
    expect(bridge.connected).toBe(true);
  });

  it('fails a call in flight when the browser disappears', async () => {
    const bridge = await startBridge();
    // Answers nothing, so the call is still outstanding when the socket dies.
    const socket = await connectStub(bridge, { answer: undefined });
    socket.removeAllListeners('message');
    await bridge.waitForBrowser();

    const pending = bridge.call({ kind: 'status' });
    socket.close();
    await expect(pending).rejects.toThrow('disconnected');
  });

  it('says what to do when no browser ever connects', async () => {
    const bridge = await startBridge();
    await expect(bridge.call({ kind: 'status' })).rejects.toThrow('No browser is connected');
  });

  it('refuses to start on a port that is already taken', async () => {
    const first = await startBridge();
    const second = new Bridge({ port: first.port, token: TOKEN, connectWaitMs: 200 });
    cleanups.push(() => {
      second.close();
    });
    await expect(second.listen()).rejects.toThrow('already in use');
  });
});
