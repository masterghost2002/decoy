import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/ui/lib/utils';

export interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2.5 px-8 py-12 text-center',
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-wash shadow-ring">
        <Icon className="size-4 text-gold" />
      </span>
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
      <p className="max-w-[36ch] text-xs leading-relaxed text-ink-muted">{description}</p>
      {action !== undefined ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
