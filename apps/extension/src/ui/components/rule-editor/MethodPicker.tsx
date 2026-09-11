import { HTTP_METHODS, METHOD_ANY, type MethodPattern } from '@mocksmith/core';

import { cn } from '@/ui/lib/utils';

const OPTIONS: MethodPattern[] = [METHOD_ANY, ...HTTP_METHODS];

/** Same colour language as the method pills in the lists, so the two read alike. */
const SELECTED_TONE: Record<string, string> = {
  '*': 'border-gold/50 bg-wash text-warn',
  GET: 'border-ok/45 bg-ok/10 text-ok',
  POST: 'border-info/45 bg-info/10 text-info',
  PUT: 'border-warn/50 bg-warn/10 text-warn',
  PATCH: 'border-warn/50 bg-warn/10 text-warn',
  DELETE: 'border-danger/45 bg-danger/10 text-danger',
  HEAD: 'border-hairline-strong bg-sunk text-ink',
  OPTIONS: 'border-hairline-strong bg-sunk text-ink',
};

export interface MethodPickerProps {
  value: MethodPattern[];
  onChange: (next: MethodPattern[]) => void;
}

/**
 * Toggle chips rather than a multi-select: picking "GET and POST" is one of the
 * most common edits here, and a chip row makes the current answer readable at a
 * glance.
 */
export function MethodPicker({ value, onChange }: MethodPickerProps) {
  const isAny = value.includes(METHOD_ANY) || value.length === 0;

  const toggle = (method: MethodPattern) => {
    if (method === METHOD_ANY) {
      onChange([METHOD_ANY]);
      return;
    }

    const withoutAny = value.filter((item) => item !== METHOD_ANY);
    const next = withoutAny.includes(method)
      ? withoutAny.filter((item) => item !== method)
      : [...withoutAny, method];

    // Matching nothing is never what someone means, so fall back to "any".
    onChange(next.length === 0 ? [METHOD_ANY] : next);
  };

  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Request methods">
      {OPTIONS.map((method) => {
        const selected = method === METHOD_ANY ? isAny : !isAny && value.includes(method);
        return (
          <button
            key={method}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              toggle(method);
            }}
            className={cn(
              'rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em] transition-colors',
              selected
                ? SELECTED_TONE[method]
                : 'border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink-muted',
            )}
          >
            {method === METHOD_ANY ? 'any' : method}
          </button>
        );
      })}
    </div>
  );
}
