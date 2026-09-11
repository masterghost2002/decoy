import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * Controls sit in a recessed well with a hairline ring instead of a drawn
 * border. Rounded, not pill-shaped: these hold monospace urls and json, and a
 * pill would waste the horizontal space they need most.
 */
const controlClasses =
  'w-full rounded-lg bg-sunk px-3 text-[14px] text-ink shadow-edge transition-shadow duration-[120ms] placeholder:text-ink-label disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(controlClasses, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        controlClasses,
        'resize-y py-2.5 font-mono text-[13px] leading-relaxed',
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
 *
 * No extra padding for the arrow. Chrome already reserves room for the picker
 * indicator inside the padding box, so adding our own on top subtracted it
 * twice and clipped the text: a 4.75rem control showed "jso".
 */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(controlClasses, 'h-9 cursor-pointer', className)} {...props}>
      {children}
    </select>
  );
}
