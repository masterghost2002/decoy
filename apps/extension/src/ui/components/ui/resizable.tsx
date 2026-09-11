import { GripVertical } from 'lucide-react';
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
  type GroupProps,
  type PanelImperativeHandle,
  type PanelProps,
  type SeparatorProps,
} from 'react-resizable-panels';

import { cn } from '@/ui/lib/utils';

/**
 * Draggable panes, on the shadcn `resizable` shape over `react-resizable-panels`.
 *
 * The tab view holds three things that compete for the same screen: a list you
 * scan, a form you fill in, and a preview you check. Which one deserves the
 * room changes with what you are doing -- writing a long json body wants the
 * middle, comparing eleven rules wants the left -- and no fixed set of column
 * widths is right for both. So the split is the user's to make, and it is
 * remembered.
 *
 * Two deliberate departures from the stock component:
 *
 * 1. A panel does not scroll. The library puts `overflow: auto` on every pane,
 *    which would give the surface three scrollbars racing the page's own. Here
 *    each pane is a flex column that hides its overflow, and the one region
 *    inside it that is allowed to scroll says so itself.
 * 2. The separator is a hairline, not a border. It only thickens under the
 *    cursor, so at rest the three panes read as one surface rather than as
 *    three windows.
 */
export function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return <Group className={cn('h-full min-h-0 w-full', className)} {...props} />;
}

export function ResizablePanel({ className, style, ...props }: PanelProps) {
  return (
    <Panel
      className={cn('flex min-h-0 min-w-0 flex-col', className)}
      // Inline, because the library sets `overflow: auto` inline too and a
      // class would lose to it.
      style={{ overflow: 'hidden', ...style }}
      {...props}
    />
  );
}

export interface ResizableHandleProps extends SeparatorProps {
  /** Adds the grip, for a separator that has to be found before it is used. */
  withHandle?: boolean;
}

export function ResizableHandle({ withHandle = false, className, ...props }: ResizableHandleProps) {
  return (
    <Separator
      className={cn(
        'relative flex w-px shrink-0 cursor-col-resize items-center justify-center bg-hairline transition-colors duration-[120ms]',
        // The line is one pixel; the thing you can grab is eleven. Without this
        // the separator is a pixel-hunting exercise.
        'after:absolute after:inset-y-0 after:left-1/2 after:w-[11px] after:-translate-x-1/2',
        'hover:bg-edge active:bg-ink',
        'data-[disabled]:cursor-default data-[disabled]:hover:bg-hairline',
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-6 w-3 items-center justify-center rounded-full bg-sunk shadow-ring-strong">
          <GripVertical aria-hidden className="size-3 text-ink-label" />
        </div>
      ) : null}
    </Separator>
  );
}

export { useDefaultLayout, usePanelRef, type PanelImperativeHandle };
