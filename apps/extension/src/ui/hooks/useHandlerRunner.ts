import {
  actionFromHandlerOutcome,
  buildHandlerRequest,
  resolveAction,
  urlCaptures,
  type MockRule,
  type SettledPlan,
} from '@mocksmith/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createHandlerClient, type HandlerClient } from '@/injected/handler-client';

export interface TestRequest {
  method: string;
  url: string;
  body: string;
}

export type TestOutcome =
  | { kind: 'idle' }
  | { kind: 'running' }
  /** The handler answered. `plan` is literally what the page would receive. */
  | { kind: 'answered'; plan: SettledPlan }
  /** The handler declined, so the rules below this one would decide. */
  | { kind: 'declined' }
  | { kind: 'failed'; message: string };

export interface HandlerRunner {
  outcome: TestOutcome;
  run: (rule: MockRule, request: TestRequest) => void;
  reset: () => void;
}

/**
 * Runs a handler from the editor, against a request the user typed.
 *
 * This is the difference between the code editor being a black box and being
 * usable. The extension's own pages cannot compile a string -- MV3's policy
 * forbids it there as firmly as a site's policy forbids it in a page -- so the
 * editor asks the same sandbox the interceptor uses. Which means what you see
 * here is produced by exactly the code path that will answer the real request,
 * not by a second implementation that can drift from it.
 */
export function useHandlerRunner(): HandlerRunner {
  const client = useRef<HandlerClient | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome>({ kind: 'idle' });
  /** Only the newest run may write a result; an earlier one is stale. */
  const latest = useRef(0);

  useEffect(() => {
    const created = createHandlerClient();
    try {
      created.setSandboxUrl(chrome.runtime.getURL('sandbox.html'));
    } catch {
      // No extension context (a stale page after a reload). `run` will say so.
    }
    client.current = created;
  }, []);

  const run = useCallback((rule: MockRule, request: TestRequest) => {
    if (rule.action.kind !== 'handler') return;
    const active = client.current;
    if (active === null || !active.available) {
      setOutcome({ kind: 'failed', message: 'The handler sandbox is not available.' });
      return;
    }

    const ticket = latest.current + 1;
    latest.current = ticket;
    setOutcome({ kind: 'running' });

    const url = absolute(request.url);
    void active
      .run({
        ruleId: `${rule.id}_test`,
        ruleName: rule.name,
        code: rule.action.code,
        timeoutMs: rule.action.timeoutMs,
        request: buildHandlerRequest(
          {
            url,
            method: request.method,
            headers: {},
            cookies: {},
            body: request.body.length > 0 ? request.body : null,
          },
          {
            transport: 'fetch',
            startedAt: Date.now(),
            params: urlCaptures(rule.matcher.url, url),
          },
        ),
      })
      .then((result) => {
        if (latest.current !== ticket) return;
        if (!result.ok) {
          setOutcome({ kind: 'failed', message: result.message });
          return;
        }
        const action = actionFromHandlerOutcome(result.outcome);
        setOutcome(
          action === null
            ? { kind: 'declined' }
            : { kind: 'answered', plan: resolveAction(action) },
        );
      });
  }, []);

  const reset = useCallback(() => {
    latest.current += 1;
    setOutcome({ kind: 'idle' });
  }, []);

  return { outcome, run, reset };
}

/**
 * A test url is usually typed as a path. The handler is given `req.host`,
 * `req.origin` and `req.query`, all of which need an absolute url to exist, so
 * a relative one is completed rather than rejected.
 */
function absolute(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return 'https://api.example.com/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://api.example.com${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}
