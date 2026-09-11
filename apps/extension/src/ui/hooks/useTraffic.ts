import { useCallback, useEffect, useState } from 'react';

import { appendTraffic, type ExtensionEvent, type TrafficEntry } from '@mocksmith/core';

import { clearTraffic, fetchTraffic } from '@/ui/lib/messaging';

export interface TrafficState {
  entries: TrafficEntry[];
  clear: () => void;
}

export function useTraffic(): TrafficState {
  const [entries, setEntries] = useState<TrafficEntry[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetchTraffic()
      .then((loaded) => {
        if (!cancelled) setEntries(loaded);
      })
      .catch(() => {
        // An unreachable worker already surfaces through the config error state.
      });

    const onEvent = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const event = message as ExtensionEvent;
      if (event.type !== 'traffic:added') return;
      setEntries((current) => appendTraffic(current, event.entries));
    };

    chrome.runtime.onMessage.addListener(onEvent);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onEvent);
    };
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    void clearTraffic();
  }, []);

  return { entries, clear };
}

/**
 * The tab behind the popup. Lets the traffic list default to "just this page",
 * which is almost always what you want while debugging one app.
 */
export function useActiveTabId(enabled: boolean): number | null {
  const [tabId, setTabId] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (cancelled) return;
      setTabId(tabs[0]?.id ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return tabId;
}
