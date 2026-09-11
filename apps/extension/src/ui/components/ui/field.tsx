import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '@/ui/lib/utils';

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('eyebrow', className)} {...props} />;
}

/** Section divider with a mono eyebrow, borrowed from editorial layouts. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="size-1.5 rotate-45 bg-gold" />
      <h3 className="eyebrow">{children}</h3>
      <span aria-hidden className="h-px flex-1 bg-hairline" />
    </div>
  );
}

export interface FieldProps {
  label: string;
  /** Receives the generated id so the label always points at the real control. */
  children: (controlId: string) => ReactNode;
  hint?: string;
  error?: string | null;
  className?: string;
}

export function Field({ label, children, hint, error, className }: FieldProps) {
  const controlId = useId();
  const message = error ?? hint;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={controlId}>{label}</Label>
      {children(controlId)}
      {message !== undefined && message !== null && message.length > 0 ? (
        <p
          className={cn('text-[11px] leading-snug', error ? 'text-danger' : 'text-ink-muted')}
          role={error ? 'alert' : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
