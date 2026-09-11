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
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      <Icon className="size-6 text-muted-foreground" />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      {action !== undefined ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
