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
    <div className="flex flex-col gap-1.5">
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
        className="w-20 font-mono"
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
              'rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
              value === preset
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border-strong text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  );
}
