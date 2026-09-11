import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '@/ui/components/ui/button';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { getPortalContainer } from '@/ui/lib/roots';
import { cn } from '@/ui/lib/utils';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps {
  title: string;
  /** Sits beside the title: pills, mode switches, a search field. */
  toolbar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Starts expanded. Useful when the content is mostly wide tables. */
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * A panel that slides in from the right, and can be expanded to fill the
 * window when what is in it deserves the room.
 *
 * Expanding is the point. A sheet is the right default -- it keeps the list
 * behind it visible, so you can see which row you opened -- but request bodies
 * and header tables are wide, and a 520px column turns them into a column of
 * wrapped fragments. Both widths are one click apart and the choice sticks for
 * as long as the sheet is open.
 */
export function SheetContent({
  title,
  toolbar,
  children,
  footer,
  defaultExpanded = false,
  className,
}: SheetContentProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    /* The container is not optional. Radix defaults to `document.body`, which
       in the floating panel is the *host page's* body -- outside the shadow
       root, and so outside every stylesheet this UI has. The sheet then
       rendered as an unstyled block appended to somebody else's document,
       which pushed their layout off the screen: clicking a request appeared to
       blank the page. Every other portal here already passes it. */
    <DialogPrimitive.Portal container={getPortalContainer()}>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-0 right-0 bottom-0 z-50 flex flex-col overflow-hidden bg-surface shadow-pop',
          'focus:outline-none',
          // Transitioning `width` rather than swapping a layout keeps the
          // expand feeling like the same panel getting bigger.
          'transition-[width] duration-[240ms] ease-out',
          expanded ? 'w-full' : 'w-full sm:w-[min(560px,92vw)]',
          className,
        )}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
          <DialogPrimitive.Title className="text-[14px] font-semibold tracking-[-0.01em]">
            {title}
          </DialogPrimitive.Title>
          {toolbar}
          <div className="ml-auto flex items-center gap-1">
            {/* Hidden below `sm`, where the sheet is already full width and the
                control would toggle nothing. */}
            <Tooltip label={expanded ? 'Collapse the panel' : 'Expand the panel'}>
              <Button
                size="icon-sm"
                variant="ghost"
                className="hidden sm:inline-flex"
                aria-pressed={expanded}
                aria-label={expanded ? 'Collapse the panel' : 'Expand the panel'}
                onClick={() => {
                  setExpanded((current) => !current);
                }}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </Tooltip>
            <DialogPrimitive.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>
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

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-[12px] leading-snug text-ink-muted', className)}
      {...props}
    />
  );
}
