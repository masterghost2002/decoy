import type { SettledPlan } from '@decoy/core';

/**
 * A plan as the bytes it becomes.
 *
 * Shared by the preview pane and the handler editor's test run, because they
 * are answering the same question -- "what will the page actually receive?" --
 * and two renderings of one answer is two things to keep in agreement.
 */
export function planToWire(plan: SettledPlan): string {
  if (plan.kind === 'passthrough') return '(the real response, untouched)';

  if (plan.kind === 'networkError') {
    const shape =
      plan.errorType === 'timeout'
        ? 'never settles'
        : plan.errorType === 'aborted'
          ? 'rejects with AbortError'
          : 'rejects with TypeError';
    return `${plan.errorType.toUpperCase()} — the request ${shape}`;
  }

  const lines = [`HTTP/1.1 ${String(plan.status)} ${plan.statusText}`.trimEnd()];
  for (const [name, value] of plan.headers) lines.push(`${name}: ${value}`);

  if (plan.kind === 'stream') {
    // One pass, exactly as framed. Seeing the `data:` prefixes and the blank
    // line between events is the point -- that framing is what a hand-written
    // SSE mock gets wrong.
    if (plan.chunks.length > 0) {
      lines.push('');
      lines.push(plan.chunks.join(''));
    }
    return lines.join('\n');
  }

  if (plan.body !== null) {
    lines.push('');
    lines.push(prettyBody(plan.body));
  }
  return lines.join('\n');
}

/** Pretty-printed for reading. The rule still sends the raw string it holds. */
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
