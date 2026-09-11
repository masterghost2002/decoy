import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { App } from '@/ui/App';
import { ErrorBoundary } from '@/ui/components/ui/error-boundary';
import { ToastProvider } from '@/ui/components/ui/toast';
import { TooltipProvider } from '@/ui/components/ui/tooltip';
import { announcePanel } from '@/ui/lib/messaging';
import { cn } from '@/ui/lib/utils';

import { clampFrame, saveFrame, type PanelFrame } from './frame';

/**
 * Which edges a grip moves. `x`/`y` move the origin, `w`/`h` change the size;
 * a west or north grip does both, because growing leftwards means the left edge
 * is what moved.
 */
const GRIPS = [
  { at: 'n', cursor: 'ns-resize', dx: 0, dy: 1, dw: 0, dh: -1, class: 'top-0 inset-x-3 h-1.5' },
  { at: 's', cursor: 'ns-resize', dx: 0, dy: 0, dw: 0, dh: 1, class: 'bottom-0 inset-x-3 h-1.5' },
  { at: 'w', cursor: 'ew-resize', dx: 1, dy: 0, dw: -1, dh: 0, class: 'left-0 inset-y-3 w-1.5' },
  { at: 'e', cursor: 'ew-resize', dx: 0, dy: 0, dw: 1, dh: 0, class: 'right-0 inset-y-3 w-1.5' },
  { at: 'nw', cursor: 'nwse-resize', dx: 1, dy: 1, dw: -1, dh: -1, class: 'top-0 left-0 size-3.5' },
  { at: 'ne', cursor: 'nesw-resize', dx: 0, dy: 1, dw: 1, dh: -1, class: 'top-0 right-0 size-3.5' },
  { at: 'sw', cursor: 'nesw-resize', dx: 1, dy: 0, dw: -1, dh: 1, class: 'bottom-0 left-0 size-3.5' },
  {
    at: 'se',
    cursor: 'nwse-resize',
    dx: 0,
    dy: 0,
    dw: 1,
    dh: 1,
    class: 'right-0 bottom-0 size-3.5',
  },
] as const;

export interface FloatingPanelProps {
  /** The clipped, rounded box this renders into. Styled imperatively, see below. */
  frameEl: HTMLElement;
  initialFrame: PanelFrame;
  onClose: () => void;
}

/**
 * The Mocksmith UI, floating over the page it is mocking.
 *
 * A browser action popup cannot be any of the things this is: it cannot be
 * moved, it cannot be resized, it closes the moment you click the page behind
 * it, and Chrome caps it at 800x600. All four of those are disqualifying when
 * the work is "change a rule, click the thing, watch what happens" -- the popup
 * makes you reopen it after every single click. So the same UI is mounted into
 * the page instead, in a shadow root, where it can stay open and out of the way.
 *
 * The frame element is positioned imperatively rather than through React state
 * flowing into a style prop. It is created before the React root exists -- the
 * portal container has to be known before the first render -- and a drag is a
 * stream of pointer events that would otherwise re-render the entire rule
 * editor on every frame.
 */
export function FloatingPanel({ frameEl, initialFrame, onClose }: FloatingPanelProps) {
  const [frame, setFrame] = useState(initialFrame);
  /** The live value during a gesture, so a move never reads a stale render. */
  const latest = useRef(frame);

  const apply = useCallback(
    (next: PanelFrame) => {
      const clamped = clampFrame(next);
      latest.current = clamped;
      frameEl.style.left = `${String(clamped.x)}px`;
      frameEl.style.top = `${String(clamped.y)}px`;
      frameEl.style.width = `${String(clamped.width)}px`;
      frameEl.style.height = `${String(clamped.height)}px`;
    },
    [frameEl],
  );

  useLayoutEffect(() => {
    apply(frame);
  }, [apply, frame]);

  // A window that shrinks below the panel can strand it off the edge.
  useEffect(() => {
    const onResize = () => {
      setFrame((current) => clampFrame(current));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const startGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      move: (dx: number, dy: number, start: PanelFrame) => PanelFrame,
    ) => {
      if (event.button !== 0) return;
      // Stops the page underneath from starting a text selection mid-drag.
      event.preventDefault();

      const start = latest.current;
      const originX = event.clientX;
      const originY = event.clientY;

      const onMove = (moveEvent: PointerEvent) => {
        apply(move(moveEvent.clientX - originX, moveEvent.clientY - originY, start));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        // One state write at the end of the gesture, not sixty during it.
        setFrame(latest.current);
        saveFrame(latest.current);
      };

      // Captured, because a page is entitled to stop propagation on its own
      // events and a half-finished drag that never ends is unrecoverable.
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    },
    [apply],
  );

  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      startGesture(event, (dx, dy, start) => ({ ...start, x: start.x + dx, y: start.y + dy }));
    },
    [startGesture],
  );

  return (
    <>
      {/* Inside the grips, not around them: a crash in the UI must still leave
          the panel draggable, resizable and closable. A stuck box on top of
          somebody's page that cannot be moved or dismissed is worse than the
          crash it is reporting. */}
      <ErrorBoundary>
        <TooltipProvider>
          <ToastProvider>
            <App view="panel" panelChrome={{ onClose, onDragPointerDown }} />
          </ToastProvider>
        </TooltipProvider>
      </ErrorBoundary>

      {GRIPS.map((grip) => (
        <div
          key={grip.at}
          role="presentation"
          style={{ cursor: grip.cursor }}
          onPointerDown={(event) => {
            startGesture(event, (dx, dy, start) => ({
              x: start.x + dx * grip.dx,
              y: start.y + dy * grip.dy,
              width: start.width + dx * grip.dw,
              height: start.height + dy * grip.dh,
            }));
          }}
          // Inside the bounds rather than straddling them: the frame clips its
          // own corners to stay round, and a grip hanging over the edge would
          // be clipped away with them.
          className={cn('absolute z-50 touch-none', grip.class)}
        />
      ))}
    </>
  );
}
