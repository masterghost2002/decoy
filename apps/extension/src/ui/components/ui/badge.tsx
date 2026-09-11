import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded font-mono text-[10px] font-semibold uppercase leading-none',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        accent: 'bg-accent text-accent-foreground',
        success: 'bg-muted text-success',
        danger: 'bg-muted text-destructive',
        outline: 'border border-border-strong text-muted-foreground',
      },
      size: {
        sm: 'px-1 py-0.5',
        md: 'px-1.5 py-1',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

/**
 * Status colour by class, with the number always visible: colour alone must not
 * be the only signal for "this failed".
 */
export function StatusBadge({ status }: { status: number | null }) {
  if (status === null) {
    return (
      <Badge tone="danger" title="No response: the request failed or is still hanging">
        err
      </Badge>
    );
  }
  const tone = status >= 500 ? 'danger' : status >= 400 ? 'accent' : 'success';
  return <Badge tone={tone}>{status}</Badge>;
}
