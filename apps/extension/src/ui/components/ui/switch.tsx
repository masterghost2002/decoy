import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

/**
 * 34 x 20, up from 32 x 18: still compact, but it clears the 28px hit target
 * with the row padding and the thumb travel is legible. A switch always applies
 * immediately -- if a control needs saving, it is a checkbox.
 *
 * Two tones, and the distinction is the palette's only rule rather than a
 * decoration:
 *
 *  - `gold` is the one place saturated gold appears, and it means exactly one
 *    thing: requests are being intercepted. The master switch and the per-rule
 *    switch, and nothing else.
 *  - `ink` is for every other switch. Agent control is on/off like any of them,
 *    but it is not interception, and a surface that spends gold on it makes the
 *    colour stop meaning anything.
 */
export interface SwitchProps extends ComponentProps<typeof SwitchPrimitive.Root> {
  tone?: 'gold' | 'ink';
}

export function Switch({ className, tone = 'gold', ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-[160ms]',
        'data-[state=unchecked]:bg-sunk data-[state=unchecked]:shadow-edge',
        tone === 'gold' ? 'data-[state=checked]:bg-gold' : 'data-[state=checked]:bg-ink',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(40,28,12,0.4)] transition-transform duration-[160ms]',
          'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
