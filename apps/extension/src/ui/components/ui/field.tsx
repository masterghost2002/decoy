import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '@/ui/lib/utils';

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        'text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
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

/**
 * Pairs a label with a control and reserves one line for a hint or error, so a
 * validation message never reflows the form under the user's cursor.
 */
export function Field({ label, children, hint, error, className }: FieldProps) {
  const controlId = useId();
  const message = error ?? hint;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={controlId}>{label}</Label>
      {children(controlId)}
      {message !== undefined && message !== null && message.length > 0 ? (
        <p
          className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
          role={error ? 'alert' : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
