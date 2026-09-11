import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * A toggle whose current answer is legible without opening anything. Used
 * wherever a dropdown would hide information a user wants at rest: methods,
 * status presets, traffic outcome filters.
 *
 * Selected is ink-filled, never gold. Selection is not interception.
 */
export interface ChipProps extends Omit<ComponentProps<'button'>, 'children'> {
  selected: boolean;
  children: ReactNode;
  /** Rendered after the label. For filters the count *is* the information. */
  count?: number;
}

export function Chip({ selected, children, count, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'tabular rounded-full border px-2.5 py-1 font-mono text-[11.5px] font-medium tracking-[0.05em] uppercase transition-colors duration-[120ms]',
        selected
          ? 'border-ink bg-ink text-paper'
          : 'border-edge text-ink-muted hover:bg-sunk hover:text-ink',
        className,
      )}
      {...props}
    >
      {children}
      {count === undefined ? null : (
        <span className={cn('ml-1.5', selected ? 'text-paper/70' : 'text-ink-label')}>{count}</span>
      )}
    </button>
  );
}

export function ChipGroup({
  label,
  className,
  ...props
}: ComponentProps<'div'> & { label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      {...props}
    />
  );
}
