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
  applyResponseBody,
  countHits,
  createDefaultConfig,
  createStarterConfig,
  pruneStats,
  type ExtensionEvent,
  type ExtensionMessage,
  type ExtensionResponse,
  type DecoyConfig,
  type RuleStats,
  type TrafficEntry,
} from '@mocksmith/core';
import { loadConfig } from '@mocksmith/core/schema';

/*
 * These four keys keep the old product name on purpose. They hold every rule
 * anyone has written, their hit counts and what the traffic log has already
 * seen; renaming them would read as tidiness and land as silent data loss.
 * The name a person sees is not the name a key has to have.
 */
const STORAGE_KEY = 'mocksmith.config.v1';
/** Session storage: hit counts belong to a debugging session, not to the profile. */
const STATS_KEY = 'mocksmith.stats.v1';
/**
 * Session storage: whether any traffic has been recorded since the browser
 * started. It outlives the worker, so a restart that empties the in-memory log
 * can be told apart from a page that simply made no requests.
 */
const TRAFFIC_SEEN_KEY = 'mocksmith.traffic.seen.v1';

const BADGE_ACTIVE_COLOUR = '#f59e0b';
const BADGE_PAUSED_COLOUR = '#64748b';

let cachedConfig: DecoyConfig | null = null;
let trafficLog: TrafficEntry[] = [];

/**
 * How many times each rule has fired. Kept apart from the traffic log because
 * the log is capped at 500 and clearable, while "has this rule ever done
 * anything?" has to survive both. Restored from session storage so an MV3
 * worker restart mid-session does not reset the counters to zero.
 */
let ruleStats: RuleStats = {};
let statsRestored = false;
let statsWriteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether this browser session has ever seen traffic. Only ever read on
 * `traffic:list`, so the UI can say "the log was dropped" instead of showing
 * the same empty state it shows before anything has happened.
 */
let trafficEverSeen = false;

/** Mocked requests per tab, for the toolbar badge. Reset on navigation. */
const tabMockCounts = new Map<number, number>();

/**
 * Tabs with a floating panel open.
 *
 * The popup and the tab view get UI events for free: `runtime.sendMessage`
 * reaches every extension page. A panel is a content script, and nothing
 * reaches one except `tabs.sendMessage` -- so the set of tabs worth addressing
 * has to be tracked, or a panel would show a traffic log that never updates.
 */
const panelTabs = new Set<number>();

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

async function persist(config: DecoyConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

async function readStoredConfig(): Promise<unknown> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY];
}

async function getConfig(): Promise<DecoyConfig> {
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
      `[decoy] repaired stored config (reset=${String(result.reset)}, droppedRules=${String(result.droppedRules)})`,
    );
    await persist(result.config);
  }
  return result.config;
}

/** Everything written goes through validation, including our own UI's writes. */
async function replaceConfig(next: unknown): Promise<{
  config: DecoyConfig;
  droppedRules: number;
}> {
  const result = loadConfig(next);
  cachedConfig = result.config;

  // A deleted rule must not leave its counter behind to be inherited by a
  // future rule that happens to reuse the id.
  const pruned = pruneStats(
    ruleStats,
    result.config.rules.map((rule) => rule.id),
  );
  if (pruned !== ruleStats) {
    ruleStats = pruned;
    publishStats();
  }

  await persist(result.config);
  await updateBadge(result.config);

  const event: ExtensionEvent = { type: 'config:changed', config: result.config };
  notifyUi(event);
  await broadcastToTabs(event);

  if (result.droppedRules > 0) {
    console.warn(
      `[decoy] refused ${String(result.droppedRules)} rule(s) on write: they did not validate`,
    );
  }

  return { config: result.config, droppedRules: result.droppedRules };
}

/* -------------------------------------------------------------------------- */
/* Rule hit counts                                                            */
/* -------------------------------------------------------------------------- */

async function restoreStats(): Promise<void> {
  if (statsRestored) return;
  statsRestored = true;
  try {
    const stored = await chrome.storage.session.get(STATS_KEY);
    const raw: unknown = stored[STATS_KEY];
    if (raw !== null && typeof raw === 'object') ruleStats = raw as RuleStats;
  } catch {
    // Session storage is unavailable in some contexts; counters simply start fresh.
  }
}

async function restoreTrafficSeen(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(TRAFFIC_SEEN_KEY);
    trafficEverSeen = stored[TRAFFIC_SEEN_KEY] === true;
  } catch {
    // Session storage is unavailable in some contexts; an empty log then just
    // reads as "nothing yet", which is the safer of the two messages.
  }
}

function markTrafficSeen(): void {
  if (trafficEverSeen) return;
  trafficEverSeen = true;
  void chrome.storage.session.set({ [TRAFFIC_SEEN_KEY]: true }).catch(() => undefined);
}

/** Debounced: a busy page reports hundreds of requests a second. */
function scheduleStatsWrite(): void {
  if (statsWriteTimer !== null) return;
  statsWriteTimer = setTimeout(() => {
    statsWriteTimer = null;
    void chrome.storage.session.set({ [STATS_KEY]: ruleStats }).catch(() => undefined);
  }, 500);
}

function publishStats(): void {
  notifyUi({ type: 'stats:changed', stats: ruleStats });
  scheduleStatsWrite();
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The default badge reports configuration -- how many rules are armed. The
 * per-tab badge reports evidence: how many requests were actually mocked on
 * that tab. A per-tab value overrides the global one wherever it is set.
 */
async function updateBadge(config: DecoyConfig): Promise<void> {
  const activeRules = config.rules.filter((rule) => rule.enabled).length;
  const text = !config.enabled ? 'off' : activeRules > 0 ? String(activeRules) : '';

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: config.enabled ? BADGE_ACTIVE_COLOUR : BADGE_PAUSED_COLOUR,
  });
}

function updateTabBadge(tabId: number): void {
  const count = tabMockCounts.get(tabId) ?? 0;
  void chrome.action
    .setBadgeText({ tabId, text: count > 0 ? String(count) : '' })
    .catch(() => undefined);
  void chrome.action
    .setBadgeBackgroundColor({ tabId, color: BADGE_ACTIVE_COLOUR })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Fan-out                                                                    */
/* -------------------------------------------------------------------------- */

function notifyUi(event: ExtensionEvent): void {
  // Rejects when no popup or tab is open, which is the common case.
  chrome.runtime.sendMessage(event).catch(() => undefined);

  for (const tabId of panelTabs) {
    chrome.tabs.sendMessage(tabId, event).catch(() => {
      // The tab navigated, closed, or the panel was dismissed without saying
      // so. Either way there is nothing there to talk to any more.
      panelTabs.delete(tabId);
    });
  }
}

/**
 * Injects the panel bundle, which toggles itself: running it a second time in a
 * tab that already has one takes it away rather than mounting a second copy.
 */
async function togglePanel(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['panel.js'] });
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
  markTrafficSeen();
  notifyUi({ type: 'traffic:added', entries: stamped });

  const nextStats = countHits(ruleStats, stamped);
  if (nextStats !== ruleStats) {
    ruleStats = nextStats;
    publishStats();
  }

  if (tabId !== null) {
    const mocked = stamped.filter((entry) => entry.outcome === 'mocked').length;
    if (mocked > 0) {
      tabMockCounts.set(tabId, (tabMockCounts.get(tabId) ?? 0) + mocked);
      updateTabBadge(tabId);
    }
  }
}

/**
 * A response body that finished reading after its entry was already logged.
 * Patched in place and announced, rather than replacing the entry, so an open
 * traffic panel fills the body in without the row moving.
 */
function recordResponseBody(id: string, body: string | null, truncated: boolean): void {
  const next = applyResponseBody(trafficLog, id, body, truncated);
  // Null means the entry is gone: pushed past the cap, or cleared while the
  // body was still being read. Either way there is nothing to announce.
  if (next === null) return;
  trafficLog = next;
  notifyUi({ type: 'traffic:body', id, body, truncated });
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
      return { ok: true, kind: 'config', config: await getConfig(), droppedRules: 0 };

    case 'config:replace': {
      const written = await replaceConfig(message.config);
      return {
        ok: true,
        kind: 'config',
        config: written.config,
        droppedRules: written.droppedRules,
      };
    }

    case 'traffic:list':
      await restoreTrafficSeen();
      return {
        ok: true,
        kind: 'traffic',
        entries: trafficLog,
        dropped: trafficLog.length === 0 && trafficEverSeen,
      };

    case 'traffic:clear':
      trafficLog = [];
      // Clearing is deliberate, so the next empty list is expected rather than
      // evidence that the worker died.
      trafficEverSeen = false;
      void chrome.storage.session.remove(TRAFFIC_SEEN_KEY).catch(() => undefined);
      return { ok: true, kind: 'ack' };

    case 'stats:get':
      await restoreStats();
      return { ok: true, kind: 'stats', stats: ruleStats };

    case 'stats:reset':
      ruleStats = {};
      tabMockCounts.clear();
      publishStats();
      return { ok: true, kind: 'ack' };

    case 'traffic:report':
      recordTraffic(message.entries, sender);
      return { ok: true, kind: 'ack' };

    case 'traffic:body':
      recordResponseBody(message.id, message.body, message.truncated);
      return { ok: true, kind: 'ack' };

    case 'panel:toggle':
      await togglePanel(message.tabId);
      return { ok: true, kind: 'ack' };

    case 'panel:attached': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) panelTabs.add(tabId);
      return { ok: true, kind: 'ack' };
    }

    case 'panel:detached': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) panelTabs.delete(tabId);
      return { ok: true, kind: 'ack' };
    }

    case 'tab:whoami':
      return { ok: true, kind: 'tab', tabId: sender.tab?.id ?? null };

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

/** A new document means a new count: the old one describes a page that is gone. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  tabMockCounts.delete(tabId);
  // A new document takes the injected panel with it. It re-registers if the
  // user opens another one.
  panelTabs.delete(tabId);
  updateTabBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMockCounts.delete(tabId);
  panelTabs.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void seedOnInstall();
});

chrome.runtime.onStartup.addListener(() => {
  void getConfig().then(updateBadge);
});

// Also runs on every worker wake-up, which is what keeps the badge honest.
void getConfig().then(updateBadge);
void restoreStats();
void restoreTrafficSeen();
