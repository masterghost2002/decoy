import { ChevronsLeft } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";

import { App } from "@/ui/App";
import { ErrorBoundary } from "@/ui/components/ui/error-boundary";
import { ToastProvider } from "@/ui/components/ui/toast";
import { TooltipProvider } from "@/ui/components/ui/tooltip";
import { announcePanel } from "@/ui/lib/messaging";
import { getPortalContainer } from "@/ui/lib/roots";
import { cn } from "@/ui/lib/utils";

import { clampFrame, saveFrame, type PanelFrame } from "./frame";

/**
 * The button left behind when the panel is folded away.
 *
 * Portalled out of the frame on purpose: the frame is the thing being hidden,
 * so anything rendered inside it would be hidden too. It lands in the same
 * shadow-root container every menu and tooltip uses, which is where the
 * stylesheet reaches.
 *
 * Pinned to the right edge rather than left where the panel was. A launcher
 * that appears wherever the panel happened to be is a launcher you have to
 * hunt for; one that is always in the same place is one you learn once.
 */
function CollapsedLauncher({ onExpand }: { onExpand: () => void }) {
  const container = getPortalContainer() ?? document.body;

  return createPortal(
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand the Decoy panel"
      title="Expand Decoy"
      className={cn(
        "fixed top-1/2 right-0 z-[2147483646] flex -translate-y-1/2 items-center gap-1.5",
        "rounded-l-full border border-r-0 border-hairline bg-surface py-2.5 pr-2 pl-3",
        "text-ink shadow-pop transition-[padding,background-color] duration-[120ms]",
        "hover:bg-sunk hover:pr-3",
      )}
    >
      <ChevronsLeft aria-hidden className="size-4 text-ink-muted" />
      <img
        src={chrome.runtime.getURL("icons/icon-32.png")}
        alt=""
        aria-hidden
        draggable={false}
        className="size-[20px] rounded"
      />
    </button>,
    container,
  );
}

/**
 * Which edges a grip moves. `x`/`y` move the origin, `w`/`h` change the size;
 * a west or north grip does both, because growing leftwards means the left edge
 * is what moved.
 */
const GRIPS = [
  {
    at: "n",
    cursor: "ns-resize",
    dx: 0,
    dy: 1,
    dw: 0,
    dh: -1,
    class: "top-0 inset-x-3 h-1.5",
  },
  {
    at: "s",
    cursor: "ns-resize",
    dx: 0,
    dy: 0,
    dw: 0,
    dh: 1,
    class: "bottom-0 inset-x-3 h-1.5",
  },
  {
    at: "w",
    cursor: "ew-resize",
    dx: 1,
    dy: 0,
    dw: -1,
    dh: 0,
    class: "left-0 inset-y-3 w-1.5",
  },
  {
    at: "e",
    cursor: "ew-resize",
    dx: 0,
    dy: 0,
    dw: 1,
    dh: 0,
    class: "right-0 inset-y-3 w-1.5",
  },
  {
    at: "nw",
    cursor: "nwse-resize",
    dx: 1,
    dy: 1,
    dw: -1,
    dh: -1,
    class: "top-0 left-0 size-3.5",
  },
  {
    at: "ne",
    cursor: "nesw-resize",
    dx: 0,
    dy: 1,
    dw: 1,
    dh: -1,
    class: "top-0 right-0 size-3.5",
  },
  {
    at: "sw",
    cursor: "nesw-resize",
    dx: 1,
    dy: 0,
    dw: -1,
    dh: 1,
    class: "bottom-0 left-0 size-3.5",
  },
  {
    at: "se",
    cursor: "nwse-resize",
    dx: 0,
    dy: 0,
    dw: 1,
    dh: 1,
    class: "right-0 bottom-0 size-3.5",
  },
] as const;

export interface FloatingPanelProps {
  /** The clipped, rounded box this renders into. Styled imperatively, see below. */
  frameEl: HTMLElement;
  initialFrame: PanelFrame;
  onClose: () => void;
}

/**
 * The Decoy UI, floating over the page it is mocking.
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
export function FloatingPanel({
  frameEl,
  initialFrame,
  onClose,
}: FloatingPanelProps) {
  const [frame, setFrame] = useState(initialFrame);
  /**
   * Folded away, but not gone. Collapsing is the answer to "I need to see the
   * thing underneath for a minute": closing would take the panel off the page
   * and lose where it was, how big it was and which rule was open, and getting
   * it back means going to the toolbar. This keeps all of that and leaves a
   * button at the edge of the page.
   */
  const [collapsed, setCollapsed] = useState(false);
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

  /*
   * Hidden, not unmounted. Unmounting would throw away the React tree and with
   * it the rule being edited, its unsaved draft and every scroll position --
   * collapsing has to be free, or nobody will use it to peek at the page.
   */
  useLayoutEffect(() => {
    frameEl.style.display = collapsed ? "none" : "flex";
  }, [collapsed, frameEl]);

  // A window that shrinks below the panel can strand it off the edge.
  useEffect(() => {
    const onResize = () => {
      setFrame((current) => clampFrame(current));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
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
        apply(
          move(moveEvent.clientX - originX, moveEvent.clientY - originY, start),
        );
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
        // One state write at the end of the gesture, not sixty during it.
        setFrame(latest.current);
        saveFrame(latest.current);
      };

      // Captured, because a page is entitled to stop propagation on its own
      // events and a half-finished drag that never ends is unrecoverable.
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    },
    [apply],
  );

  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      startGesture(event, (dx, dy, start) => ({
        ...start,
        x: start.x + dx,
        y: start.y + dy,
      }));
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
            <App
              view="panel"
              panelChrome={{
                onClose,
                onCollapse: () => {
                  setCollapsed(true);
                },
                onDragPointerDown,
              }}
            />
          </ToastProvider>
        </TooltipProvider>
      </ErrorBoundary>

      {collapsed ? (
        <CollapsedLauncher
          onExpand={() => {
            setCollapsed(false);
          }}
        />
      ) : null}

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
          className={cn("absolute z-50 touch-none", grip.class)}
        />
      ))}
    </>
  );
}
