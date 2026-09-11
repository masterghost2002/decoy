import { HTTP_METHODS, METHOD_ANY, type MethodPattern } from '@decoy/core';
import { ChevronDown } from 'lucide-react';

import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuSeparator,
  MenuTrigger,
} from '@/ui/components/ui/menu';
import { cn } from '@/ui/lib/utils';

export interface MethodPickerProps {
  value: MethodPattern[];
  onChange: (next: MethodPattern[]) => void;
  className?: string;
}

/** "any", "GET", "GET POST", then a count -- the trigger is 6rem wide. */
function summarize(value: MethodPattern[], isAny: boolean): string {
  if (isAny) return 'any';
  if (value.length <= 2) return value.join(' ');
  return `${value[0] ?? ''} +${String(value.length - 1)}`;
}

/**
 * Which methods a rule answers, as a dropdown beside the url rather than a row
 * of eight chips under it.
 *
 * The chips were honest -- every option visible, one click to change -- but they
 * cost a full line of the form to say "any" nine times out of ten, directly
 * above the field that actually decides whether the rule fires. The method is
 * part of the request line, so it now sits in it: `GET  contains  /api/users`
 * reads as one sentence, and the eight-way choice is one click away for the
 * tenth case.
 *
 * Checkboxes rather than a select, because picking "GET and POST" is a normal
 * edit here and a multi-select listbox cannot express it without modifier keys.
 */
export function MethodPicker({ value, onChange, className }: MethodPickerProps) {
  const isAny = value.includes(METHOD_ANY) || value.length === 0;
  const selected = isAny ? [] : value;

  const toggle = (method: MethodPattern, checked: boolean) => {
    if (method === METHOD_ANY) {
      onChange([METHOD_ANY]);
      return;
    }

    const next = checked
      ? [...selected, method].filter((item, index, all) => all.indexOf(item) === index)
      : selected.filter((item) => item !== method);

    // Matching nothing is never what someone means, so fall back to "any".
    onChange(next.length === 0 ? [METHOD_ANY] : next);
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Request methods: ${isAny ? 'any' : selected.join(', ')}`}
        className={cn(
          'flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-sunk px-3 font-mono text-[13px] text-ink shadow-edge transition-shadow duration-[120ms]',
          'hover:bg-sunk/70 data-[state=open]:bg-sunk/70',
          className,
        )}
      >
        <span className="min-w-0 truncate">{summarize(selected, isAny)}</span>
        <ChevronDown aria-hidden className="ml-auto size-3.5 shrink-0 text-ink-label" />
      </MenuTrigger>

      <MenuContent align="start" className="min-w-[11rem]">
        <MenuCheckboxItem
          checked={isAny}
          onCheckedChange={() => {
            toggle(METHOD_ANY, true);
          }}
          // Kept open, because ticking three methods should not cost three trips.
          onSelect={(event) => {
            event.preventDefault();
          }}
        >
          <span className="font-mono text-[13px]">any</span>
          <span className="ml-auto text-[12px] text-ink-label">every method</span>
        </MenuCheckboxItem>

        <MenuSeparator />

        {HTTP_METHODS.map((method) => (
          <MenuCheckboxItem
            key={method}
            checked={selected.includes(method)}
            onCheckedChange={(checked) => {
              toggle(method, checked);
            }}
            onSelect={(event) => {
              event.preventDefault();
            }}
          >
            <span className="font-mono text-[13px]">{method}</span>
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
