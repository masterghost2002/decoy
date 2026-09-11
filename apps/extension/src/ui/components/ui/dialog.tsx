import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/ui/components/ui/button';
import { getPortalContainer } from '@/ui/lib/roots';
import { cn } from '@/ui/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface FullscreenDialogProps {
  title: string;
  /** Sits beside the title: mode switches, a search field, a Format button. */
  toolbar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Near-fullscreen editing surface. A JSON body is the one thing in this product
 * that genuinely needs room, and an eight-row textarea inside a 420px popup is
 * not room. Inset rather than edge-to-edge so it still reads as a layer above
 * the app rather than a navigation.
 */
export function FullscreenDialogContent({
  title,
  toolbar,
  children,
  footer,
  className,
}: FullscreenDialogProps) {
  return (
    <DialogPrimitive.Portal container={getPortalContainer()}>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-2 z-50 flex flex-col overflow-hidden rounded-2xl bg-surface shadow-pop',
          'shadow-[inset_0_0_0_1px_var(--hairline),var(--shadow-pop)]',
          'focus:outline-none sm:inset-4',
          className,
        )}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
          <DialogPrimitive.Title className="text-[14px] font-semibold tracking-[-0.01em]">
            {title}
          </DialogPrimitive.Title>
          {toolbar}
          <DialogPrimitive.Close asChild className="ml-auto">
            <Button size="icon-sm" variant="ghost" aria-label="Close">
              <X />
            </Button>
          </DialogPrimitive.Close>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">{children}</div>

        {footer !== undefined ? (
          <footer className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-2">
            {footer}
          </footer>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-[12px] leading-snug text-ink-muted', className)}
      {...props}
    />
  );
}
