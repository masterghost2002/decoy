import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

import { getPortalContainer } from '@/ui/lib/roots';
import { cn } from '@/ui/lib/utils';

/**
 * A real tooltip, and the only one. It exists for icon-only controls: it names
 * the action in two or three words and is never the only place a fact lives.
 *
 * It replaces the native `title` attribute, which is not a tooltip: it waits
 * about a second, cannot be styled, never appears on keyboard focus, is
 * invisible on touch, and is announced inconsistently by screen readers.
 *
 * The tooltip node itself is `aria-hidden` and the label is put on the trigger
 * instead, so nothing is announced twice.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** 2-5 words, sentence case, no full stop. Never interactive, never a link. */
  label: string;
  /** The trigger. Give it its own accessible name -- this is reinforcement. */
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function Tooltip({ label, children, side = 'top' }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={getPortalContainer()}>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          // The popup viewport is only 420 x 600; a tooltip must never overflow it.
          collisionPadding={8}
          aria-hidden
          className={cn(
            'z-50 max-w-[14.5rem] rounded-[7px] bg-ink px-2.5 py-1.5 text-[12.5px] leading-snug font-medium text-paper shadow-pop',
            'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out select-none',
          )}
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-ink" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
