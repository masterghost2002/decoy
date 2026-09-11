import { METHOD_ANY, type MethodPattern, type TrafficOutcome } from '@mocksmith/core';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * Outlined mono pills carry almost all the categorical information in this UI:
 * methods, status classes, outcomes. Outlines rather than fills, so a dense list
 * of them stays quiet, and each one keeps its own colour so a row can be read
 * without decoding a legend.
 */
export function Pill({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] font-medium uppercase leading-[1.5] tabular',
        className,
      )}
      {...props}
    />
  );
}

const METHOD_TONE: Record<string, string> = {
  GET: 'border-ok/35 text-ok',
  POST: 'border-info/35 text-info',
  PUT: 'border-warn/40 text-warn',
  PATCH: 'border-warn/40 text-warn',
  DELETE: 'border-danger/35 text-danger',
  HEAD: 'border-hairline-strong text-ink-faint',
  OPTIONS: 'border-hairline-strong text-ink-faint',
};

export function MethodPill({ method }: { method: MethodPattern | string }) {
  if (method === METHOD_ANY) {
    return <Pill className="border-hairline-strong text-ink-muted">any</Pill>;
  }
  return (
    <Pill className={METHOD_TONE[method.toUpperCase()] ?? 'border-hairline-strong text-ink-muted'}>
      {method}
    </Pill>
  );
}

/** Colour follows the status class, but the number is always shown as well. */
export function StatusPill({ status }: { status: number | null }) {
  if (status === null) {
    return (
      <Pill
        className="border-danger/35 text-danger"
        title="No response: the request failed or is still hanging"
      >
        err
      </Pill>
    );
  }

  const tone =
    status >= 500
      ? 'border-danger/35 text-danger'
      : status >= 400
        ? 'border-warn/40 text-warn'
        : status >= 300
          ? 'border-info/35 text-info'
          : 'border-ok/35 text-ok';

  return <Pill className={tone}>{status}</Pill>;
}

const OUTCOME_LABEL: Record<TrafficOutcome, string> = {
  mocked: 'mocked',
  passthrough: 'real',
  failed: 'failed',
};

export function OutcomePill({
  outcome,
  title,
}: {
  outcome: TrafficOutcome;
  title?: string | undefined;
}) {
  const tone =
    outcome === 'mocked'
      ? 'border-gold/45 bg-wash text-warn'
      : outcome === 'failed'
        ? 'border-danger/35 text-danger'
        : 'border-hairline-strong text-ink-faint';

  return (
    <Pill className={tone} title={title}>
      {OUTCOME_LABEL[outcome]}
    </Pill>
  );
}
