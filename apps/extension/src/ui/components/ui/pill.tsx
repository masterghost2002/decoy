import { METHOD_ANY, type TrafficOutcome } from '@decoy/core';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * Outlined mono pills carry almost all the categorical information in this UI:
 * methods, status classes, outcomes. Outlines rather than fills, so a dense list
 * of them stays quiet, and each one keeps its own word or number, so colour is
 * never the only signal.
 */
export function Pill({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] leading-[1.6] font-medium tracking-[0.04em] whitespace-nowrap uppercase',
        className,
      )}
      {...props}
    />
  );
}

const METHOD_TONE: Record<string, string> = {
  GET: 'border-ok/40 text-ok',
  POST: 'border-info/40 text-info',
  PUT: 'border-warn/45 text-warn',
  PATCH: 'border-warn/45 text-warn',
  DELETE: 'border-danger/40 text-danger',
  HEAD: 'border-hairline-strong text-ink-muted',
  OPTIONS: 'border-hairline-strong text-ink-muted',
};

export function MethodPill({ method }: { method: string }) {
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
    // No `title`: the pill's meaning is spelled out on the row's outcome pill
    // and in full in the detail drawer. The label is here for screen readers,
    // which cannot infer it from three letters.
    return (
      <Pill className="border-danger/40 text-danger" aria-label="No response: the request failed">
        err
      </Pill>
    );
  }

  const tone =
    status >= 500
      ? 'border-danger/40 text-danger'
      : status >= 400
        ? 'border-warn/45 text-warn'
        : status >= 300
          ? 'border-info/40 text-info'
          : 'border-ok/40 text-ok';

  return <Pill className={tone}>{status}</Pill>;
}

const OUTCOME_LABEL: Record<TrafficOutcome, string> = {
  mocked: 'mocked',
  passthrough: 'real',
  failed: 'failed',
};

/**
 * `mocked` is the one row-state that has to be findable in a 200-row log, so it
 * gets the only solid gold fill in the product. `real` is a dashed outline, so
 * it reads as "not ours" without spending a colour on it.
 */
const OUTCOME_TONE: Record<TrafficOutcome, string> = {
  mocked: 'border-gold bg-gold font-semibold text-on-gold',
  passthrough: 'border-dashed border-hairline-strong text-ink-muted',
  failed: 'border-danger/40 text-danger',
};

export function OutcomePill({ outcome }: { outcome: TrafficOutcome }) {
  return <Pill className={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Pill>;
}
