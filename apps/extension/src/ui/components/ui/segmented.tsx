import { cn } from '@/ui/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
}

/**
 * A raised pill on a recessed track. Replaces a row of full-width filled
 * buttons, which read as three competing calls to action rather than one
 * setting with three positions.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex gap-0.5 rounded-full bg-sunk p-0.5 shadow-ring', className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            title={option.hint}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              'flex-1 rounded-full px-2 py-1 text-xs font-medium transition-[background-color,box-shadow,color]',
              selected
                ? 'bg-surface text-ink shadow-soft'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
