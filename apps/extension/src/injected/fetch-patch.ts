import { decideRequest, type NetworkErrorType } from '@mocksmith/core';

import type { ConfigGate } from './config-gate.js';
import type { Reporter } from './reporter.js';
import { buildMockResponse } from './response.js';
import { delay, hangForever } from './timing.js';
import { describeFetchRequest, resolveAbortSignal } from './url.js';

export interface FetchPatchContext {
  gate: ConfigGate;
  report: Reporter;
}

/** Mirrors the errors the platform itself raises, so app error handling behaves. */
function networkError(errorType: NetworkErrorType): unknown {
  if (errorType === 'aborted') {
    return new DOMException('The user aborted a request.', 'AbortError');
  }
  // Chrome uses this exact message for DNS failures and CORS rejections alike.
  return new TypeError('Failed to fetch');
}

export function installFetchPatch(context: FetchPatchContext): void {
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;

  const patchedFetch = async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAt = Date.now();
    const descriptor = describeFetchRequest(input, init);

    if (!context.gate.isReady) await context.gate.waitUntilReady();
    const config = context.gate.snapshot();
    const decision = config === null ? null : decideRequest(config, descriptor);

    const ruleId = decision?.rule.id ?? null;
    const ruleName = decision?.rule.name ?? null;

    if (decision === null || decision.plan.kind === 'passthrough') {
      try {
        const response = await nativeFetch.call(window, input as RequestInfo, init);
        context.report({
          ...descriptor,
          transport: 'fetch',
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: 'passthrough',
          status: response.status,
          ruleId,
          ruleName,
        });
        return response;
      } catch (error) {
        context.report({
          ...descriptor,
          transport: 'fetch',
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: 'failed',
          status: null,
          ruleId,
          ruleName,
        });
        throw error;
      }
    }

    const signal = resolveAbortSignal(input, init);
    const plan = decision.plan;

    const report = (outcome: 'mocked' | 'failed', status: number | null) => {
      context.report({
        ...descriptor,
        transport: 'fetch',
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome,
        status,
        ruleId,
        ruleName,
      });
    };

    if (plan.kind === 'networkError') {
      try {
        await delay(plan.delayMs, signal);
      } catch (error) {
        // An abort mid-delay is still a request worth seeing in the log.
        report('failed', null);
        throw error;
      }
      report('failed', null);
      if (plan.errorType === 'timeout') {
        // Never settles: the caller's own timeout logic is what we are testing.
        return hangForever(signal);
      }
      throw networkError(plan.errorType);
    }

    try {
      await delay(plan.delayMs, signal);
    } catch (error) {
      report('failed', null);
      throw error;
    }

    report('mocked', plan.status);
    return buildMockResponse(plan, descriptor.url);
  };

  // Some libraries sniff for a patched fetch by stringifying it, then take a
  // different and less-tested code path. Presenting as native avoids that.
  Object.defineProperty(patchedFetch, 'name', { value: 'fetch', configurable: true });
  Object.defineProperty(patchedFetch, 'toString', {
    value: () => 'function fetch() { [native code] }',
    configurable: true,
    writable: true,
  });

  window.fetch = patchedFetch as typeof window.fetch;
}
