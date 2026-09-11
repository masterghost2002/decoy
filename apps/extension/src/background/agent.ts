/**
 * The bridge to an agent.
 *
 * An MCP server is a local process; this is a browser extension. They have to
 * meet somewhere, and the direction is forced: an MV3 service worker cannot
 * listen for connections, but it can open one. So the bridge runs a WebSocket
 * server on the loopback interface and the worker dials out to it.
 *
 * That direction turns out to be the right one twice over. It keeps the
 * extension in control -- nothing can reach it that it did not choose to
 * connect to -- and an open WebSocket resets the worker's idle timer, so the
 * connection also solves the problem of MV3 shutting the worker down in the
 * middle of a conversation.
 *
 * Off by default. It is switched on in the UI, against a token the UI shows,
 * because a socket that lets another process rewrite what your app sees is not
 * something to enable quietly.
 */
import {
  AGENT_CHANNEL,
  AGENT_PROTOCOL_VERSION,
  applyAgentCommand,
  filterTraffic,
  isAgentRequest,
  summarizeTraffic,
  type AgentCommand,
  type AgentHello,
  type AgentReply,
  type DecoyConfig,
  type TrafficEntry,
} from '@decoy/core';
import { parseAgentCommand } from '@decoy/core/schema';

/** Kept apart from the rule set on purpose: a token must never travel with a shared config. */
export const AGENT_STORAGE_KEY = 'decoy.agent.v1';

export interface AgentSettings {
  enabled: boolean;
  port: number;
  /** Generated in the extension and shown once, for the agent's own config. */
  token: string;
}

export type AgentConnectionState = 'off' | 'connecting' | 'connected' | 'refused' | 'error';

export interface AgentStatus {
  state: AgentConnectionState;
  port: number;
  /** What went wrong, in a sentence, for the UI to print rather than a code. */
  detail: string;
  since: number;
}

/**
 * What the bridge needs from the worker. Passed in rather than imported so this
 * file has no opinion about how config is stored, and so the whole thing can be
 * driven by a test with no browser at all.
 */
export interface AgentHost {
  getConfig: () => Promise<DecoyConfig>;
  replaceConfig: (config: DecoyConfig) => Promise<{ config: DecoyConfig; droppedRules: number }>;
  getTraffic: () => readonly TrafficEntry[];
  clearTraffic: () => void;
  onStatusChange: (status: AgentStatus) => void;
}

/** Backoff between reconnects. The bridge is usually simply not running yet. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

export function createAgentBridge(host: AgentHost) {
  let socket: WebSocket | null = null;
  let settings: AgentSettings | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUs = false;

  let status: AgentStatus = { state: 'off', port: 0, detail: '', since: Date.now() };

  function setStatus(state: AgentConnectionState, detail = ''): void {
    status = { state, port: settings?.port ?? 0, detail, since: Date.now() };
    host.onStatusChange(status);
  }

  function cancelRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(): void {
    if (settings?.enabled !== true) return;
    cancelRetry();
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 30_000;
    attempt += 1;
    retryTimer = setTimeout(connect, wait);
  }

  function connect(): void {
    if (settings === null || !settings.enabled) return;
    disconnect(false);
    closedByUs = false;
    setStatus('connecting');

    let next: WebSocket;
    try {
      next = new WebSocket(`ws://127.0.0.1:${String(settings.port)}`);
    } catch (error) {
      setStatus('error', describe(error));
      scheduleRetry();
      return;
    }
    socket = next;

    next.addEventListener('open', () => {
      attempt = 0;
      const hello: AgentHello = {
        channel: AGENT_CHANNEL,
        kind: 'hello',
        version: AGENT_PROTOCOL_VERSION,
        token: settings?.token ?? '',
        client: 'decoy-extension',
      };
      next.send(JSON.stringify(hello));
      setStatus('connected');
    });

    next.addEventListener('message', (event) => {
      void handleFrame(next, String(event.data));
    });

    next.addEventListener('close', (event) => {
      socket = null;
      if (closedByUs) return;
      /*
       * 4401 is the bridge saying the token did not match. Retrying on a loop
       * would be pointless and would look like a flapping connection rather
       * than the configuration error it is.
       */
      if (event.code === 4401) {
        setStatus(
          'refused',
          'The bridge rejected the token. Copy it again from here into your agent config.',
        );
        return;
      }
      setStatus('connecting', 'Waiting for the bridge. Start it with `npx @decoy/mcp`.');
      scheduleRetry();
    });

    // `error` carries nothing useful in a worker; `close` follows it with the
    // code that does.
    next.addEventListener('error', () => undefined);
  }

  function disconnect(report = true): void {
    cancelRetry();
    closedByUs = true;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
      socket = null;
    }
    if (report) setStatus('off');
  }

  async function handleFrame(from: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isAgentRequest(parsed)) return;

    const reply = await answer(parsed.command);
    const message: AgentReply = { channel: AGENT_CHANNEL, kind: 'reply', id: parsed.id, ...reply };
    try {
      from.send(JSON.stringify(message));
    } catch {
      // The bridge went away mid-answer; the close handler will reconnect.
    }
  }

  /** Validates, then runs. Everything an agent sends is treated as untrusted. */
  async function answer(
    raw: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const checked = parseAgentCommand(raw);
    if (!checked.ok || checked.command === undefined) {
      return { ok: false, error: checked.error ?? 'the command did not validate' };
    }
    const command: AgentCommand = checked.command;

    try {
      if (command.kind === 'traffic.list') {
        const entries = filterTraffic(host.getTraffic(), command);
        return {
          ok: true,
          data: { entries: entries.map(summarizeTraffic), total: host.getTraffic().length },
        };
      }
      if (command.kind === 'traffic.clear') {
        host.clearTraffic();
        return { ok: true, data: { cleared: true } };
      }
      if (command.kind === 'status') {
        const config = await host.getConfig();
        return {
          ok: true,
          data: {
            protocol: AGENT_PROTOCOL_VERSION,
            mocking: config.enabled,
            rules: config.rules.length,
            enabledRules: config.rules.filter((rule) => rule.enabled).length,
            traffic: host.getTraffic().length,
          },
        };
      }

      const config = await host.getConfig();
      const result = applyAgentCommand(config, command, Date.now());
      if (!result.ok) return result;

      if (result.config === undefined) return { ok: true, data: result.data };

      /*
       * Written through the same path the UI uses, so an agent's rule is
       * validated exactly as a hand-written one is. A rule the worker refuses
       * has to be reported: silently storing fewer rules than were sent is the
       * kind of thing an agent will confidently build on.
       */
      const written = await host.replaceConfig(result.config);
      if (written.droppedRules > 0) {
        return {
          ok: false,
          error: `${String(written.droppedRules)} rule(s) failed validation and were not stored.`,
        };
      }
      return { ok: true, data: result.data };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  return {
    /** Applies new settings, connecting, reconnecting or stopping as they say. */
    apply(next: AgentSettings | null): void {
      const before = settings;
      settings = next;

      if (next === null || !next.enabled) {
        disconnect();
        return;
      }
      // A port or token change has to be a fresh connection, not a no-op.
      const changed =
        before === null ||
        !before.enabled ||
        before.port !== next.port ||
        before.token !== next.token;
      if (changed || socket === null) {
        attempt = 0;
        connect();
      }
    },
    status: () => status,
    stop: () => {
      disconnect();
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'something went wrong';
}

/** Settings as stored, repaired into something usable. */
export function readAgentSettings(raw: unknown): AgentSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const port = typeof candidate['port'] === 'number' ? candidate['port'] : 0;
  const token = typeof candidate['token'] === 'string' ? candidate['token'] : '';
  if (port < 1 || port > 65_535 || token.length === 0) return null;
  return { enabled: candidate['enabled'] === true, port, token };
}
