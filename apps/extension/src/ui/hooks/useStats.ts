import { useCallback, useEffect, useState } from 'react';

import type { ExtensionEvent, RuleStats } from '@decoy/core';

import { fetchStats, resetStats } from '@/ui/lib/messaging';

export interface StatsState {
  stats: RuleStats;
  reset: () => void;
}

/**
 * How many times each rule has fired. Pushed from the worker as traffic
 * arrives, so a rule row can say "fired 14×" without the UI counting anything
 * itself.
 */
export function useStats(): StatsState {
  const [stats, setStats] = useState<RuleStats>({});

  useEffect(() => {
    let cancelled = false;

    fetchStats()
      .then((loaded) => {
        if (!cancelled) setStats(loaded);
      })
      .catch(() => {
        // An unreachable worker already surfaces through the config error state.
      });

    const onEvent = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const event = message as ExtensionEvent;
      if (event.type !== 'stats:changed') return;
      setStats(event.stats);
    };

    chrome.runtime.onMessage.addListener(onEvent);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onEvent);
    };
  }, []);

  const reset = useCallback(() => {
    setStats({});
    void resetStats();
  }, []);

  return { stats, reset };
}
