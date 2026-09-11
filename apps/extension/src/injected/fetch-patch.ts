import {
  capBody,
  decideRequest,
  type HeaderPair,
  type NetworkErrorType,
  type SettledPlan,
} from '@mocksmith/core';

import {
  assembleRequest,
  collectFetchBody,
  collectFetchHeaders,
  headersToPairs,
} from './facts.js';
import type { ConfigGate } from './config-gate.js';
import type { HandlerClient } from './handler-client.js';
import { settleDecision } from './handler-run.js';
import type { Reporter } from './reporter.js';
import { captureResponseBody } from './response-capture.js';
import { buildMockResponse, buildStreamResponse } from './response.js';
import { delay, hangForever } from './timing.js';
import { describeFetchRequest, resolveAbortSignal } from './url.js';

export interface FetchPatchContext {
  gate: ConfigGate;
  report: Reporter;
  handlers: HandlerClient;
}

/**
 * What the traffic log records as the response body. A stream reports one pass
 * of its chunk list: that is what the rule says it sends, and a repeating
 * stream only says it again.
 */
function mockedBodyOf(plan: SettledPlan): string | null {
  if (plan.kind === 'respond') return plan.body;
  if (plan.kind === 'stream') return capBody(plan.chunks.join('')).body;
  return null;
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

    // Headers, cookies and payload are needed before the decision, because a
    // rule may carry conditions that test them.
    const collected = assembleRequest(
      descriptor.url,
      descriptor.method,
      collectFetchHeaders(input, init),
      await collectFetchBody(input, init),
    );
    const detail = {
      requestHeaders: collected.requestHeaders,
      requestBody: collected.requestBody,
      requestBodyTruncated: collected.requestBodyTruncated,
    };

    if (!context.gate.isReady) await context.gate.waitUntilReady();
    const config = context.gate.snapshot();
    const found = config === null ? null : decideRequest(config, collected.facts);

    // A rule whose action is code has not answered yet: it has to run first,
    // and it may decline, in which case the rule below it answers instead.
    const decision =
      found === null || config === null
        ? null
        : await settleDecision({
            config,
            facts: collected.facts,
            decision: found,
            client: context.handlers,
            transport: 'fetch',
            startedAt,
          });

    const ruleId = decision?.rule.id ?? null;
    const ruleName = decision?.rule.name ?? null;

    if (decision === null || decision.plan.kind === 'passthrough') {
      try {
        const response = await nativeFetch.call(window, input as RequestInfo, init);
        const id = context.report({
          ...descriptor,
          ...detail,
          transport: 'fetch',
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: 'passthrough',
          status: response.status,
          ruleId,
          ruleName,
          responseHeaders: headersToPairs(response.headers),
        });
        // Deliberately not awaited: the page gets its response now, and the
        // body follows whenever the clone finishes reading.
        void captureResponseBody(response).then((captured) => {
          context.report.body(id, captured.body, captured.truncated);
        });
        return response;
      } catch (error) {
        context.report({
          ...descriptor,
          ...detail,
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

    const report = (
      outcome: 'mocked' | 'failed',
      status: number | null,
      responseHeaders: HeaderPair[] = [],
    ) => {
      context.report({
        ...descriptor,
        ...detail,
        transport: 'fetch',
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome,
        status,
        ruleId,
        ruleName,
        responseHeaders,
        // We synthesized it, so there is nothing to read back.
        responseBody: outcome === 'mocked' ? mockedBodyOf(plan) : null,
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

    // Reported at the head, not at the last chunk: `fetch` resolves as soon as
    // the head arrives, and a stream set to repeat forever would otherwise
    // never show up in the log at all.
    if (plan.kind === 'stream') {
      const streamed = buildStreamResponse(plan, descriptor.url, signal);
      report('mocked', plan.status, headersToPairs(streamed.headers));
      return streamed;
    }

    const mocked = buildMockResponse(plan, descriptor.url);
    report('mocked', plan.status, headersToPairs(mocked.headers));
    return mocked;
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
