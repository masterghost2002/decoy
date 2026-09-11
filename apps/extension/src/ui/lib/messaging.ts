import type {
  ExtensionMessage,
  ExtensionResponse,
  DecoyConfig,
  RuleStats,
  TrafficEntry,
} from '@mocksmith/core';

class WorkerError extends Error {}

async function send(message: ExtensionMessage): Promise<ExtensionResponse> {
  let response: ExtensionResponse | undefined;
  try {
    response = await chrome.runtime.sendMessage<ExtensionMessage, ExtensionResponse | undefined>(
      message,
    );
  } catch (error) {
    throw new WorkerError(
      error instanceof Error ? error.message : 'Could not reach the Decoy background worker.',
    );
  }

  if (response === undefined) {
    throw new WorkerError('The Decoy background worker did not respond.');
  }
  if (response.ok !== true) {
    throw new WorkerError(response.error);
  }
  return response;
}

export async function fetchConfig(): Promise<DecoyConfig> {
  const response = await send({ type: 'config:get' });
  if (response.ok !== true || response.kind !== 'config') {
    throw new WorkerError('Unexpected reply to config:get.');
  }
  return response.config;
}

export interface SaveResult {
  /** The config as stored, which may differ if validation repaired it. */
  config: DecoyConfig;
  /** Rules the worker would not store. Always zero unless something is wrong. */
  droppedRules: number;
}

export async function saveConfig(config: DecoyConfig): Promise<SaveResult> {
  const response = await send({ type: 'config:replace', config });
  if (response.ok !== true || response.kind !== 'config') {
    throw new WorkerError('Unexpected reply to config:replace.');
  }
  return { config: response.config, droppedRules: response.droppedRules };
}

export interface TrafficSnapshot {
  entries: TrafficEntry[];
  dropped: boolean;
}

export async function fetchTraffic(): Promise<TrafficSnapshot> {
  const response = await send({ type: 'traffic:list' });
  if (response.ok !== true || response.kind !== 'traffic') {
    throw new WorkerError('Unexpected reply to traffic:list.');
  }
  return { entries: response.entries, dropped: response.dropped };
}

export async function clearTraffic(): Promise<void> {
  await send({ type: 'traffic:clear' });
}

export async function fetchStats(): Promise<RuleStats> {
  const response = await send({ type: 'stats:get' });
  if (response.ok !== true || response.kind !== 'stats') {
    throw new WorkerError('Unexpected reply to stats:get.');
  }
  return response.stats;
}

export async function resetStats(): Promise<void> {
  await send({ type: 'stats:reset' });
}

export function openFullPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('tab.html') });
}

/**
 * Mounts the floating panel in a tab, or takes it away again. Only the worker
 * holds `chrome.scripting`, so this is a request rather than an action.
 */
export async function togglePanel(tabId: number): Promise<void> {
  await send({ type: 'panel:toggle', tabId });
}

/**
 * The tab a floating panel is sitting in. A content script has no
 * `chrome.tabs`, so the only way to learn this is to ask the side that can read
 * the message sender.
 */
export async function fetchOwnTabId(): Promise<number | null> {
  const response = await send({ type: 'tab:whoami' });
  if (response.ok !== true || response.kind !== 'tab') {
    throw new WorkerError('Unexpected reply to tab:whoami.');
  }
  return response.tabId;
}

/** Best effort, and deliberately unawaited: nothing should wait on bookkeeping. */
export function announcePanel(attached: boolean): void {
  void chrome.runtime
    .sendMessage({ type: attached ? 'panel:attached' : 'panel:detached' })
    .catch(() => undefined);
}
