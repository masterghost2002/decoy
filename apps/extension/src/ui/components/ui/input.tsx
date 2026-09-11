import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * Controls sit in a recessed well with a hairline ring instead of a drawn
 * border. Rounded, not pill-shaped: these hold monospace urls and json, and a
 * pill would waste the horizontal space they need most.
 */
const controlClasses =
  'w-full rounded-lg bg-sunk px-2.5 text-[13px] text-ink shadow-ring transition-shadow placeholder:text-ink-faint focus:shadow-ring-strong disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(controlClasses, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        controlClasses,
        'resize-y py-2 font-mono text-xs leading-relaxed',
        className,
      )}
      spellCheck={false}
      {...props}
    />
  );
}

/**
 * A native select rather than a portalled listbox: keyboard and screen-reader
 * behaviour comes for free, and nothing can escape the 420px popup viewport.
 */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(controlClasses, 'h-8 cursor-pointer pr-6', className)} {...props}>
      {children}
    </select>
  );
}
