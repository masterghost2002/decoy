import { useCallback, useEffect, useState } from 'react';

import type { ExtensionEvent } from '@decoy/core';

import {
  fetchAgentState,
  rotateAgentToken,
  saveAgentState,
  type AgentState,
} from '@/ui/lib/messaging';

export interface AgentControl {
  agent: AgentState | null;
  error: string | null;
  setEnabled: (enabled: boolean) => void;
  setPort: (port: number) => void;
  rotate: () => void;
}

const UNKNOWN = 'Could not reach the Decoy background worker.';

/**
 * Agent control, and the state of the connection it produces.
 *
 * The connection state is pushed rather than polled: a socket that is retrying
 * every few seconds has to be visible *while* it retries, or the only thing the
 * panel can honestly say is "switched on", which is configuration rather than
 * evidence.
 */
export function useAgent(): AgentControl {
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((work: Promise<AgentState>) => {
    work
      .then((next) => {
        setAgent(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : UNKNOWN);
      });
  }, []);

  useEffect(() => {
    apply(fetchAgentState());

    const onEvent = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const event = message as ExtensionEvent;
      if (event.type !== 'agent:changed') return;
      const { enabled, port, token, state, detail } = event;
      setAgent({ enabled, port, token, state, detail });
    };

    chrome.runtime.onMessage.addListener(onEvent);
    return () => {
      chrome.runtime.onMessage.removeListener(onEvent);
    };
  }, [apply]);

  return {
    agent,
    error,
    setEnabled: (enabled) => {
      apply(saveAgentState(enabled, agent?.port ?? 0));
    },
    setPort: (port) => {
      apply(saveAgentState(agent?.enabled ?? false, port));
    },
    rotate: () => {
      apply(rotateAgentToken());
    },
  };
}
