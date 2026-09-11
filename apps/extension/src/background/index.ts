/**
 * Service worker. Single source of truth for the rule set: it owns persistence,
 * validates everything on the way in, and pushes changes out to every page and
 * every open UI surface.
 *
 * MV3 terminates this worker aggressively, so nothing here may assume it stays
 * alive: config is read back from storage on demand, and the in-memory traffic
 * log is explicitly a per-worker-lifetime convenience, not durable state.
 */
import {
  TRAFFIC_LOG_LIMIT,
  appendTraffic,
  createDefaultConfig,
  createStarterConfig,
  type ExtensionEvent,
  type ExtensionMessage,
  type ExtensionResponse,
  type MocksmithConfig,
  type TrafficEntry,
} from '@mocksmith/core';
import { loadConfig } from '@mocksmith/core/schema';

const STORAGE_KEY = 'mocksmith.config.v1';

const BADGE_ACTIVE_COLOUR = '#f59e0b';
const BADGE_PAUSED_COLOUR = '#64748b';

let cachedConfig: MocksmithConfig | null = null;
let trafficLog: TrafficEntry[] = [];

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

async function persist(config: MocksmithConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

async function readStoredConfig(): Promise<unknown> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY];
}

async function getConfig(): Promise<MocksmithConfig> {
  if (cachedConfig !== null) return cachedConfig;

  const raw = await readStoredConfig();

  if (raw === undefined) {
    // Nothing stored yet. Seeding belongs to onInstalled: writing from this
    // read path would be a read-then-write that can clobber whatever else is
    // starting up at the same moment.
    const empty = createDefaultConfig();
    cachedConfig = empty;
    return empty;
  }

  const result = loadConfig(raw);
  cachedConfig = result.config;
  if (result.reset || result.droppedRules > 0) {
    console.warn(
      `[mocksmith] repaired stored config (reset=${String(result.reset)}, droppedRules=${String(result.droppedRules)})`,
    );
    await persist(result.config);
  }
  return result.config;
}

/** Everything written goes through validation, including our own UI's writes. */
async function replaceConfig(next: unknown): Promise<MocksmithConfig> {
  const result = loadConfig(next);
  cachedConfig = result.config;

  await persist(result.config);
  await updateBadge(result.config);

  const event: ExtensionEvent = { type: 'config:changed', config: result.config };
  notifyUi(event);
  await broadcastToTabs(event);

  return result.config;
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

async function updateBadge(config: MocksmithConfig): Promise<void> {
  const activeRules = config.rules.filter((rule) => rule.enabled).length;
  const text = !config.enabled ? 'off' : activeRules > 0 ? String(activeRules) : '';

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: config.enabled ? BADGE_ACTIVE_COLOUR : BADGE_PAUSED_COLOUR,
  });
}

/* -------------------------------------------------------------------------- */
/* Fan-out                                                                    */
/* -------------------------------------------------------------------------- */

function notifyUi(event: ExtensionEvent): void {
  // Rejects when no popup or tab is open, which is the common case.
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

async function broadcastToTabs(event: ExtensionEvent): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        // Reaches every frame, so iframes pick up the change too.
        await chrome.tabs.sendMessage(tab.id, event);
      } catch {
        // Tabs without our content script (chrome:// pages, the web store).
      }
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Traffic                                                                    */
/* -------------------------------------------------------------------------- */

function recordTraffic(entries: TrafficEntry[], sender: chrome.runtime.MessageSender): void {
  if (entries.length === 0) return;

  // The page cannot know these, and should not be trusted with them anyway.
  const tabId = sender.tab?.id ?? null;
  const pageUrl = sender.tab?.url ?? null;
  const stamped = entries.map((entry) => ({ ...entry, tabId, pageUrl }));

  trafficLog = appendTraffic(trafficLog, stamped, TRAFFIC_LOG_LIMIT);
  notifyUi({ type: 'traffic:added', entries: stamped });
}

/* -------------------------------------------------------------------------- */
/* Message routing                                                            */
/* -------------------------------------------------------------------------- */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'config:get':
      return { ok: true, kind: 'config', config: await getConfig() };

    case 'config:replace':
      return { ok: true, kind: 'config', config: await replaceConfig(message.config) };

    case 'traffic:list':
      return { ok: true, kind: 'traffic', entries: trafficLog };

    case 'traffic:clear':
      trafficLog = [];
      return { ok: true, kind: 'ack' };

    case 'traffic:report':
      recordTraffic(message.entries, sender);
      return { ok: true, kind: 'ack' };

    default:
      return { ok: false, error: `Unknown message: ${JSON.stringify(message)}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message as ExtensionMessage, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: describeError(error) } satisfies ExtensionResponse);
    });
  // Keeps the response channel open for the async work above.
  return true;
});

/**
 * Storage can change without going through `config:replace`: a second window's
 * worker, an import, or a future sync backend. Re-reading here keeps the cached
 * copy, the badge and every page in step with what is actually stored.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[STORAGE_KEY];
  if (change === undefined) return;

  const result = loadConfig(change.newValue);
  // Skip the echo of our own write.
  if (cachedConfig !== null && JSON.stringify(cachedConfig) === JSON.stringify(result.config)) {
    return;
  }

  cachedConfig = result.config;
  const event: ExtensionEvent = { type: 'config:changed', config: result.config };
  void updateBadge(result.config);
  notifyUi(event);
  void broadcastToTabs(event);
});

/** First run only, and only when nothing is stored, so a reinstall or an
 *  upgrade never overwrites someone's rules. */
async function seedOnInstall(): Promise<void> {
  if ((await readStoredConfig()) !== undefined) {
    await getConfig().then(updateBadge);
    return;
  }

  const starter = createStarterConfig(Date.now());
  cachedConfig = starter;
  await persist(starter);
  await updateBadge(starter);
}

chrome.runtime.onInstalled.addListener(() => {
  void seedOnInstall();
});

chrome.runtime.onStartup.addListener(() => {
  void getConfig().then(updateBadge);
});

// Also runs on every worker wake-up, which is what keeps the badge honest.
void getConfig().then(updateBadge);
