/**
 * How often each rule has actually fired. Kept apart from the traffic log
 * because the log is capped and clearable, while "has this rule ever done
 * anything?" is a question that outlives both.
 */
export interface RuleStat {
  hits: number;
  /** Epoch ms of the most recent hit, or 0 if it has never fired. */
  lastHitAt: number;
}

export type RuleStats = Record<string, RuleStat>;

export const EMPTY_RULE_STAT: RuleStat = { hits: 0, lastHitAt: 0 };

export function readRuleStat(stats: RuleStats, ruleId: string): RuleStat {
  return stats[ruleId] ?? EMPTY_RULE_STAT;
}

/**
 * Counts one hit per entry that a rule decided. Returns a fresh object so a
 * mid-render UI never observes a half-updated map.
 */
export function countHits(
  stats: RuleStats,
  entries: readonly { ruleId: string | null; startedAt: number }[],
): RuleStats {
  let changed = false;
  const next: RuleStats = { ...stats };

  for (const entry of entries) {
    if (entry.ruleId === null) continue;
    const current = next[entry.ruleId] ?? EMPTY_RULE_STAT;
    next[entry.ruleId] = {
      hits: current.hits + 1,
      lastHitAt: Math.max(current.lastHitAt, entry.startedAt),
    };
    changed = true;
  }

  return changed ? next : stats;
}

/** Drops counters for rules that no longer exist, so the map cannot grow forever. */
export function pruneStats(stats: RuleStats, liveRuleIds: readonly string[]): RuleStats {
  const live = new Set(liveRuleIds);
  const next: RuleStats = {};
  let dropped = false;
  for (const [ruleId, stat] of Object.entries(stats)) {
    if (live.has(ruleId)) next[ruleId] = stat;
    else dropped = true;
  }
  return dropped ? next : stats;
}

/** "just now", "12s", "4m" -- short enough to sit inside a rule row. */
export function formatSince(lastHitAt: number, now: number): string {
  if (lastHitAt === 0) return 'never';
  const seconds = Math.max(0, Math.round((now - lastHitAt) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)}h ago`;
}
