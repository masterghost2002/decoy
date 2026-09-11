import { Input } from '@/ui/components/ui/input';
import { cn } from '@/ui/lib/utils';

/** The statuses people actually reach for when reproducing a bug. */
const PRESETS = [200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503] as const;

export interface StatusPickerProps {
  controlId: string;
  value: number;
  onChange: (next: number) => void;
}

export function StatusPicker({ controlId, value, onChange }: StatusPickerProps) {
  return (
    <div className="flex flex-col gap-2">
      <Input
        id={controlId}
        type="number"
        min={200}
        max={599}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (!Number.isNaN(parsed)) onChange(parsed);
        }}
        className="w-[4.5rem] font-mono tabular"
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Common status codes">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={value === preset}
            onClick={() => {
              onChange(preset);
            }}
            className={cn(
              'rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tabular transition-colors',
              value === preset
                ? 'border-gold/50 bg-wash text-warn'
                : 'border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink-muted',
            )}
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  );
}
