import type {
  ExtensionMessage,
  ExtensionResponse,
  MocksmithConfig,
  TrafficEntry,
} from '@mocksmith/core';

class WorkerError extends Error {}

async function send(message: ExtensionMessage): Promise<ExtensionResponse> {
  let response: ExtensionResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage(message)) as ExtensionResponse | undefined;
  } catch (error) {
    throw new WorkerError(
      error instanceof Error ? error.message : 'Could not reach the Mocksmith background worker.',
    );
  }

  if (response === undefined) {
    throw new WorkerError('The Mocksmith background worker did not respond.');
  }
  if (response.ok !== true) {
    throw new WorkerError(response.error);
  }
  return response;
}

export async function fetchConfig(): Promise<MocksmithConfig> {
  const response = await send({ type: 'config:get' });
  if (response.ok !== true || response.kind !== 'config') {
    throw new WorkerError('Unexpected reply to config:get.');
  }
  return response.config;
}

/** Returns the config as stored, which may differ if validation repaired it. */
export async function saveConfig(config: MocksmithConfig): Promise<MocksmithConfig> {
  const response = await send({ type: 'config:replace', config });
  if (response.ok !== true || response.kind !== 'config') {
    throw new WorkerError('Unexpected reply to config:replace.');
  }
  return response.config;
}

export async function fetchTraffic(): Promise<TrafficEntry[]> {
  const response = await send({ type: 'traffic:list' });
  if (response.ok !== true || response.kind !== 'traffic') {
    throw new WorkerError('Unexpected reply to traffic:list.');
  }
  return response.entries;
}

export async function clearTraffic(): Promise<void> {
  await send({ type: 'traffic:clear' });
}

export function openFullPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('tab.html') });
}
