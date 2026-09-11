import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * The one place saturated gold appears. It means "requests are being
 * intercepted", and nothing else in the UI is allowed to claim that colour.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors',
        'data-[state=checked]:bg-gold-bright data-[state=unchecked]:bg-sunk data-[state=unchecked]:shadow-ring-strong',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(40,28,12,0.35)] transition-transform',
          'data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
