import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

const controlClasses =
  'w-full rounded-md border border-border-strong bg-card px-2 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(controlClasses, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(controlClasses, 'resize-y py-1.5 font-mono text-xs leading-relaxed', className)}
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
