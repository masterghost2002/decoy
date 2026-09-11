import { HTTP_METHODS, METHOD_ANY, type MethodPattern } from '@mocksmith/core';

import { cn } from '@/ui/lib/utils';

const OPTIONS: MethodPattern[] = [METHOD_ANY, ...HTTP_METHODS];

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
              'rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold transition-colors',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border-strong text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {method === METHOD_ANY ? 'ANY' : method}
          </button>
        );
      })}
    </div>
  );
}
