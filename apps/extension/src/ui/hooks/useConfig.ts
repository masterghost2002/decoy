import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExtensionEvent, MocksmithConfig } from '@mocksmith/core';

import { fetchConfig, saveConfig } from '@/ui/lib/messaging';

export type ConfigStatus = 'loading' | 'ready' | 'error';

export interface ConfigState {
  config: MocksmithConfig | null;
  status: ConfigStatus;
  error: string | null;
  /** Optimistic: applies locally, then persists through the worker. */
  update: (next: MocksmithConfig) => void;
  reload: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useConfig(): ConfigState {
  const [config, setConfig] = useState<MocksmithConfig | null>(null);
  const [status, setStatus] = useState<ConfigStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  /** While a save is in flight, our own optimistic state is the truth. */
  const pendingSaves = useRef(0);

  const reload = useCallback(() => {
    setStatus('loading');
    fetchConfig()
      .then((loaded) => {
        setConfig(loaded);
        setError(null);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        setError(describeError(cause));
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    reload();

    const onEvent = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const event = message as ExtensionEvent;
      if (event.type !== 'config:changed') return;
      // Ignoring echoes of our own writes keeps a fast series of toggles from
      // flickering back to older values.
      if (pendingSaves.current > 0) return;
      setConfig(event.config);
    };

    chrome.runtime.onMessage.addListener(onEvent);
    return () => {
      chrome.runtime.onMessage.removeListener(onEvent);
    };
  }, [reload]);

  const update = useCallback((next: MocksmithConfig) => {
    setConfig(next);
    pendingSaves.current += 1;
    saveConfig(next)
      .then((stored) => {
        setConfig(stored.config);
        // The worker drops rules it cannot validate, and the reply is what we
        // then render -- so a dropped rule would disappear from the list with
        // no explanation. This is a bug in whatever built the rule, and it says
        // so rather than pretending the click never happened.
        setError(
          stored.droppedRules > 0
            ? `${String(stored.droppedRules)} rule${stored.droppedRules === 1 ? '' : 's'} could not be saved: the rule was not valid. Please report this.`
            : null,
        );
      })
      .catch((cause: unknown) => {
        setError(describeError(cause));
      })
      .finally(() => {
        pendingSaves.current -= 1;
      });
  }, []);

  return { config, status, error, update, reload };
}
