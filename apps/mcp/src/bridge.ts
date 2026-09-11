/**
 * The half of the bridge that lives outside the browser.
 *
 * It listens on the loopback interface and waits for exactly one extension to
 * dial in. Everything about that is deliberate:
 *
 *  - **Loopback only.** A socket that can rewrite what an app sees is not one
 *    to expose on a network interface, and there is no case where the agent and
 *    the browser are on different machines.
 *  - **The extension connects to us.** An MV3 service worker cannot listen. It
 *    can dial out, and doing so also keeps it awake, which solves a second
 *    problem for free.
 *  - **One connection.** A second browser claiming the same token would make
 *    "which one answered?" a question nobody wants to ask mid-conversation, so
 *    the newest wins and the older one is told why it was dropped.
 */
import { randomUUID } from 'node:crypto';

import {
  AGENT_CHANNEL,
  AGENT_PROTOCOL_VERSION,
  isAgentHello,
  isAgentReply,
  type AgentCommand,
  type AgentRequest,
} from '@decoy/core';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

/** How long a tool call waits for the browser before giving up on it. */
const CALL_TIMEOUT_MS = 15_000;

/** Close codes the extension knows how to read. */
const CLOSE_BAD_TOKEN = 4401;
const CLOSE_BAD_VERSION = 4426;
const CLOSE_SUPERSEDED = 4409;

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeOptions {
  port: number;
  token: string;
  host?: string;
  /**
   * How long a call waits for a browser that has not connected yet. Generous by
   * default, because the usual case is an agent calling a tool a moment before
   * someone switches the extension on.
   */
  connectWaitMs?: number;
  /** Progress worth printing to stderr; stdout belongs to the MCP transport. */
  log?: (line: string) => void;
}

export class Bridge {
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #options: Required<BridgeOptions>;
  /** Resolves the first time a browser connects, so a tool call can wait for it. */
  #connected: Promise<void>;
  #announceConnected: (() => void) | null = null;

  constructor(options: BridgeOptions) {
    this.#options = {
      port: options.port,
      token: options.token,
      host: options.host ?? '127.0.0.1',
      connectWaitMs: options.connectWaitMs ?? 5000,
      log: options.log ?? (() => undefined),
    };
    this.#connected = new Promise((resolve) => {
      this.#announceConnected = resolve;
    });
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  get port(): number {
    return this.#options.port;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port: this.#options.port, host: this.#options.host });
      this.#server = server;

      server.on('listening', () => {
        this.#options.log(`listening on ws://${this.#options.host}:${String(this.#options.port)}`);
        resolve();
      });
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(
            new BridgeError(
              `Port ${String(this.#options.port)} is already in use.`,
              'Another Decoy bridge is probably already running. Stop it, or set DECOY_PORT to a free port and change the port in the extension to match.',
            ),
          );
          return;
        }
        reject(error);
      });
      server.on('connection', (socket) => {
        this.#greet(socket);
      });
    });
  }

  #greet(socket: WebSocket): void {
    // Nothing is accepted from a socket until it has said hello with the right
    // token; an unauthenticated connection can do nothing but be closed.
    let authenticated = false;

    socket.on('message', (raw: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeFrame(raw));
      } catch {
        return;
      }

      if (!authenticated) {
        if (!isAgentHello(parsed)) return;
        if (parsed.version !== AGENT_PROTOCOL_VERSION) {
          this.#options.log(
            `refused a client speaking protocol ${String(parsed.version)}; this bridge speaks ${String(AGENT_PROTOCOL_VERSION)}`,
          );
          socket.close(CLOSE_BAD_VERSION, 'protocol version mismatch');
          return;
        }
        if (parsed.token !== this.#options.token) {
          this.#options.log('refused a client with the wrong token');
          socket.close(CLOSE_BAD_TOKEN, 'bad token');
          return;
        }

        authenticated = true;
        if (this.#socket !== null && this.#socket !== socket) {
          this.#socket.close(CLOSE_SUPERSEDED, 'another browser connected');
        }
        this.#socket = socket;
        this.#options.log(`connected: ${parsed.client}`);
        this.#announceConnected?.();
        return;
      }

      if (!isAgentReply(parsed)) return;
      const waiting = this.#pending.get(parsed.id);
      if (waiting === undefined) return;
      this.#pending.delete(parsed.id);
      clearTimeout(waiting.timer);
      if (parsed.ok) waiting.resolve(parsed.data);
      else waiting.reject(new BridgeError(parsed.error));
    });

    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#options.log('the browser disconnected');
      // Whoever was waiting is never going to hear back.
      for (const [id, waiting] of this.#pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new BridgeError('The browser disconnected before answering.'));
        this.#pending.delete(id);
      }
      this.#connected = new Promise((resolve) => {
        this.#announceConnected = resolve;
      });
    });

    socket.on('error', () => {
      // A dead socket closes; there is nothing useful to add here.
    });
  }

  /** Waits up to `ms` for a browser, so a first tool call does not race the connect. */
  async waitForBrowser(ms = this.#options.connectWaitMs): Promise<boolean> {
    if (this.#socket !== null) return true;
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));
    return await Promise.race([this.#connected.then(() => true), timeout]);
  }

  async call(command: AgentCommand): Promise<unknown> {
    if (this.#socket === null) {
      const arrived = await this.waitForBrowser();
      if (!arrived) {
        throw new BridgeError(
          'No browser is connected to the bridge.',
          `Open Decoy in Chrome, switch on Agent control, and check the port is ${String(this.#options.port)} and the token matches DECOY_TOKEN.`,
        );
      }
    }

    const socket = this.#socket;
    if (socket === null) throw new BridgeError('No browser is connected to the bridge.');

    const id = randomUUID();
    const request: AgentRequest = { channel: AGENT_CHANNEL, kind: 'command', id, command };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new BridgeError(
            `The browser did not answer ${command.kind} within ${String(CALL_TIMEOUT_MS / 1000)}s.`,
          ),
        );
      }, CALL_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(request), (error) => {
        if (error === undefined || error === null) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BridgeError(error.message));
      });
    });
  }

  close(): void {
    for (const waiting of this.#pending.values()) clearTimeout(waiting.timer);
    this.#pending.clear();
    this.#socket?.close();
    this.#socket = null;
    this.#server?.close();
    this.#server = null;
  }
}

/** `ws` hands over a Buffer, an ArrayBuffer or an array of Buffers. */
function decodeFrame(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}
