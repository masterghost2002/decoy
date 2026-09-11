import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex shrink-0 gap-5 border-b border-hairline bg-surface px-3.5', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'eyebrow relative -mb-px border-b-2 border-transparent py-2.5 transition-colors duration-[120ms]',
        // Ink, not gold: which tab is open is navigation, not interception.
        'hover:text-ink-muted data-[state=active]:border-ink data-[state=active]:text-ink',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('min-h-0 flex-1 focus-visible:outline-none', className)}
      {...props}
    />
  );
}
