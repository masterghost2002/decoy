import { cn } from '@/ui/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /**
   * What picking this option does. Rendered under the control by the caller,
   * for the selected option only -- it used to live in `title`, where it was
   * effectively invisible.
   */
  hint: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
}

/**
 * A raised pill on a recessed track: two to four exclusive options with short
 * labels, where seeing all of them at once is the point. Replaces a row of
 * full-width filled buttons, which read as three competing calls to action
 * rather than one setting with three positions.
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
      className={cn('flex gap-0.5 rounded-full bg-sunk p-0.5 shadow-edge', className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              'flex-1 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-[background-color,box-shadow,color] duration-[120ms]',
              selected ? 'bg-surface text-ink shadow-soft' : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The selected option's explanation, as visible helper text under the track. */
export function segmentedHint<T extends string>(
  options: Array<SegmentedOption<T>>,
  value: T,
): string {
  return options.find((option) => option.value === value)?.hint ?? '';
}
