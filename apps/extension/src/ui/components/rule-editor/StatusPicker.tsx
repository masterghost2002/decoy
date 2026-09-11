import { HTTP_STATUSES, defaultStatusText } from '@mocksmith/core';
import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

import { Input } from '@/ui/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/ui/components/ui/menu';
import { cn } from '@/ui/lib/utils';

export interface StatusPickerProps {
  controlId: string;
  value: number;
  onChange: (next: number) => void;
}

interface StatusGroup {
  label: string;
  statuses: typeof HTTP_STATUSES;
}

/** Class boundaries, so a 40-entry list stays scannable by what it means. */
const GROUPS: Array<{ label: string; from: number; to: number }> = [
  { label: '2xx Success', from: 200, to: 299 },
  { label: '3xx Redirect', from: 300, to: 399 },
  { label: '4xx Client error', from: 400, to: 499 },
  { label: '5xx Server error', from: 500, to: 599 },
];

function statusTone(status: number): string {
  if (status >= 500) return 'text-danger';
  if (status >= 400) return 'text-warn';
  if (status >= 300) return 'text-info';
  return 'text-ok';
}

/**
 * The number and its name, as two halves of one control.
 *
 * This used to be an input over thirteen preset chips. The chips were two rows
 * of bare numbers that had to be read as numbers -- nothing on screen said 422
 * was Unprocessable Content -- and thirteen of roughly forty real statuses is a
 * shortlist that is wrong for whoever needs the fourteenth.
 *
 * So the list moved into a dropdown that carries every status with its reason
 * phrase, grouped by class, and the field beside it still takes any code from
 * 200 to 599 typed straight in. Neither half hides the other: the input always
 * shows the current code, and the trigger always names it.
 */
export function StatusPicker({ controlId, value, onChange }: StatusPickerProps) {
  const groups = useMemo<StatusGroup[]>(
    () =>
      GROUPS.map((group) => ({
        label: group.label,
        statuses: HTTP_STATUSES.filter(
          (entry) => entry.status >= group.from && entry.status <= group.to,
        ),
      })).filter((group) => group.statuses.length > 0),
    [],
  );

  const name = defaultStatusText(value);

  return (
    <div className="flex items-center gap-1.5">
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
        className={cn('tabular w-[4.75rem] shrink-0 font-mono', statusTone(value))}
      />

      <Menu>
        <MenuTrigger
          aria-label={`Status ${String(value)}${name.length > 0 ? `, ${name}` : ''}`}
          className={cn(
            'flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg bg-sunk px-3 text-[13.5px] text-ink shadow-edge transition-shadow duration-[120ms]',
            'hover:bg-sunk/70 data-[state=open]:bg-sunk/70',
          )}
        >
          <span className={cn('min-w-0 truncate', name.length === 0 && 'text-ink-label')}>
            {/* A code with no conventional name is a legitimate thing to mock,
                so it is named as what it is rather than flagged as wrong. */}
            {name.length > 0 ? name : 'Custom status'}
          </span>
          <ChevronDown aria-hidden className="ml-auto size-3.5 shrink-0 text-ink-label" />
        </MenuTrigger>

        <MenuContent
          align="start"
          className="max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] min-w-[15rem] overflow-y-auto"
        >
          {groups.map((group, index) => (
            <div key={group.label}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuLabel>{group.label}</MenuLabel>
              {group.statuses.map((entry) => (
                <MenuItem
                  key={entry.status}
                  onSelect={() => {
                    onChange(entry.status);
                  }}
                  className={cn(entry.status === value && 'bg-wash')}
                >
                  <span
                    className={cn(
                      'tabular w-9 shrink-0 font-mono text-[13px] font-medium',
                      statusTone(entry.status),
                    )}
                  >
                    {entry.status}
                  </span>
                  <span className="min-w-0 truncate">{entry.text}</span>
                </MenuItem>
              ))}
            </div>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}
