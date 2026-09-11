import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { getPortalContainer } from '@/ui/lib/roots';
import { cn } from '@/ui/lib/utils';

export interface ListboxOption<T extends string> {
  value: T;
  label: string;
  /** One line, shown beside the label. This is the whole point of the control. */
  description: ReactNode;
}

export interface ListboxProps<T extends string> {
  id?: string;
  value: T;
  options: Array<ListboxOption<T>>;
  onChange: (next: T) => void;
  /** Names the control for screen readers when no visible label points at it. */
  ariaLabel?: string;
  className?: string;
}

/**
 * An exclusive choice where every option needs a second line to be understood.
 *
 * The url match mode is the one control in this product that earns a custom
 * listbox: six bare words in a native `<select>` decide whether a rule ever
 * fires, and the explanation of each only helps *before* you choose. A native
 * select cannot show a second line, so the descriptions move into the list.
 *
 * Built on Radix Select rather than by hand, because the native control gave
 * away a lot for free -- arrow keys, type-ahead, Enter and Esc, an announced
 * current value, collision-aware placement inside a 420px popup -- and a
 * half-built listbox is worse than the select it replaced.
 */
export function Listbox<T extends string>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: ListboxProps<T>) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(next) => {
        onChange(next as T);
      }}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg bg-sunk px-3 font-mono text-[13px] text-ink shadow-edge transition-shadow duration-[120ms]',
          'hover:bg-sunk/70 data-[state=open]:bg-sunk/70',
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-ink-label" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal container={getPortalContainer()}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            'z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[10px] bg-surface shadow-pop',
            'shadow-[inset_0_0_0_1px_var(--hairline),var(--shadow-pop)]',
          )}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className={cn(
                  'flex cursor-pointer items-baseline gap-2.5 px-2.5 py-2 outline-none select-none',
                  'border-t border-hairline first:border-t-0',
                  // The wash-and-rail treatment is reused here because the
                  // current value genuinely is the "live" one.
                  'data-[state=checked]:bg-wash data-[state=checked]:shadow-[inset_2px_0_0_var(--gold)]',
                  'data-[highlighted]:bg-sunk data-[highlighted]:data-[state=checked]:bg-wash',
                )}
              >
                {/* The wrapper stays outside `ItemText`: Radix clones that
                    node into the trigger, and a fixed-width column there would
                    strand the chevron halfway across the control. */}
                <span className="w-[5.25rem] shrink-0 font-mono text-[13px] font-medium text-ink">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </span>
                <span className="helper min-w-0 flex-1">{option.description}</span>
                <SelectPrimitive.ItemIndicator asChild>
                  <Check className="size-3 shrink-0 self-center text-gold-text" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
