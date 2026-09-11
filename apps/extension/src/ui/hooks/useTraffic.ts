import { useCallback, useEffect, useState } from 'react';

import {
  appendTraffic,
  applyResponseBody,
  type ExtensionEvent,
  type TrafficEntry,
} from '@mocksmith/core';

import { clearTraffic, fetchOwnTabId, fetchTraffic } from '@/ui/lib/messaging';

export interface TrafficState {
  entries: TrafficEntry[];
  /**
   * The worker recorded traffic this session and then lost it to an MV3
   * shutdown. The traffic panel says so rather than showing the same empty
   * state it shows before anything has happened.
   */
  dropped: boolean;
  clear: () => void;
}

export function useTraffic(): TrafficState {
  const [entries, setEntries] = useState<TrafficEntry[]>([]);
  const [dropped, setDropped] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchTraffic()
      .then((snapshot) => {
        if (cancelled) return;
        setEntries(snapshot.entries);
        setDropped(snapshot.dropped);
      })
      .catch(() => {
        // An unreachable worker already surfaces through the config error state.
      });

    const onEvent = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const event = message as ExtensionEvent;

      if (event.type === 'traffic:added') {
        // Fresh traffic answers the question the notice was asking.
        setDropped(false);
        setEntries((current) => appendTraffic(current, event.entries));
        return;
      }

      // A body that arrived after its entry. The row does not move; the
      // detail sheet simply gains a response.
      if (event.type === 'traffic:body') {
        setEntries(
          (current) => applyResponseBody(current, event.id, event.body, event.truncated) ?? current,
        );
      }
    };

    chrome.runtime.onMessage.addListener(onEvent);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onEvent);
    };
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    setDropped(false);
    void clearTraffic();
  }, []);

  return { entries, dropped, clear };
}

/**
 * The tab this surface is about, so the traffic list can default to "just this
 * page" -- almost always what you want while debugging one app.
 *
 * Each surface answers it differently. The popup floats over a tab and asks
 * `chrome.tabs` which one. The floating panel *is* in a tab, but as a content
 * script it has no `chrome.tabs` at all, so it asks the worker to read the
 * message sender. The full tab view is about no page in particular.
 */
export function useScopeTabId(view: 'popup' | 'tab' | 'panel'): number | null {
  const [tabId, setTabId] = useState<number | null>(null);

  useEffect(() => {
    if (view === 'tab') return;
    let cancelled = false;

    const resolve =
      view === 'popup'
        ? chrome.tabs
            .query({ active: true, currentWindow: true })
            .then((tabs) => tabs[0]?.id ?? null)
        : fetchOwnTabId();

    void resolve
      .then((resolved) => {
        if (!cancelled) setTabId(resolved);
      })
      .catch(() => {
        // No scope is a working state: the strip simply speaks more generally.
      });

    return () => {
      cancelled = true;
    };
  }, [view]);

  return tabId;
}
