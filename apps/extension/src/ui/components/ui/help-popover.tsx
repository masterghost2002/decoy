import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { getPortalContainer, originalTarget } from '@/ui/lib/roots';
import { cn } from '@/ui/lib/utils';

export interface HelpPopoverProps {
  /** Names the concept, not the control: "How priority works". */
  title: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  className?: string;
}

/** Gap between the trigger and the panel, and the panel's clearance from the edge. */
const MARGIN = 8;

interface Placement {
  top: number;
  left: number;
}

/**
 * Click-triggered explanation behind a `?`. Deliberately rare: it is reserved
 * for the two ideas here that are too big for one line of helper text and too
 * important to leave in a README -- the priority model, and wildcard/regex
 * syntax. Anything smaller belongs under the control as visible helper text.
 *
 * Click rather than hover, because it holds several lines and examples: content
 * you have to keep a cursor still to read is content you cannot read.
 *
 * Portalled and positioned against the viewport rather than laid out next to
 * the trigger. Absolutely positioned, it was a 19rem panel inside a pane that
 * can be dragged down to 15rem: the paragraph explaining the priority model was
 * cut off mid-sentence by the pane it was explaining.
 */
export function HelpPopover({
  title,
  children,
  side = 'top',
  align = 'start',
  className,
}: HelpPopoverProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const panelId = useId();
  const wrapper = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /**
   * Measured from the live boxes on every scroll and resize, rather than
   * computed once on open. The form behind this scrolls, and a panel that stays
   * where the trigger used to be is worse than one that is clipped.
   */
  const place = useCallback(() => {
    const trigger = wrapper.current;
    const box = panel.current;
    if (trigger === null || box === null) return;

    const anchor = trigger.getBoundingClientRect();
    const size = box.getBoundingClientRect();

    // Flip only when the preferred side cannot hold it, and then only to the
    // side with more room -- so a panel taller than both never oscillates.
    const roomAbove = anchor.top - MARGIN;
    const roomBelow = window.innerHeight - anchor.bottom - MARGIN;
    const wantsAbove = side === 'top';
    const fits = wantsAbove ? roomAbove >= size.height : roomBelow >= size.height;
    const above = fits ? wantsAbove : roomAbove > roomBelow;

    const wanted = align === 'start' ? anchor.left : anchor.right - size.width;

    setPlacement({
      top: clamp(
        above ? anchor.top - size.height - MARGIN : anchor.bottom + MARGIN,
        window.innerHeight - size.height,
      ),
      left: clamp(wanted, window.innerWidth - size.width),
    });
  }, [side, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }

    place();
    // Capturing, so a scroll in the form's own scroll container counts and not
    // just one on the window.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        // Focus goes back to the trigger, or it lands on the document body.
        wrapper.current?.querySelector('button')?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // `composedPath`, not `target`: inside the floating panel's shadow root a
      // document-level listener sees the host element for every click, and this
      // popover would close the instant you reached for it.
      const from = originalTarget(event);
      if (from === null) return;
      // The panel is portalled out of the wrapper, so it has to be asked
      // separately -- otherwise selecting a line of the explanation closes it.
      if (wrapper.current?.contains(from) === true) return;
      if (panel.current?.contains(from) === true) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  // Moving focus in means the content is reachable by keyboard at all, and that
  // Esc has somewhere sensible to return from.
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  const content = (
    <div
      ref={panel}
      id={panelId}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        // Hidden for the single frame before it has been measured, so it is
        // never seen in the corner on its way to the trigger.
        visibility: placement === null ? 'hidden' : 'visible',
      }}
      className={cn(
        'fixed z-50 w-[19rem] max-w-[calc(100vw-1rem)] rounded-[10px] bg-surface p-3 shadow-pop focus:outline-none',
        'shadow-[inset_0_0_0_1px_var(--hairline),var(--shadow-pop)]',
      )}
    >
      <h4 className="mb-1.5 text-[13.5px] font-semibold tracking-[-0.01em] text-ink">{title}</h4>
      <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-ink-muted">
        {children}
      </div>
    </div>
  );

  return (
    <span ref={wrapper} className={cn('inline-flex', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={title}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={cn(
          'hit-28 grid size-5 place-items-center rounded-full border font-mono text-[11px] leading-none transition-colors duration-[120ms]',
          open
            ? 'border-ink bg-ink text-paper'
            : 'border-edge text-ink-muted hover:border-ink hover:text-ink',
        )}
      >
        ?
      </button>

      {open ? createPortal(content, getPortalContainer() ?? document.body) : null}
    </span>
  );
}

/** Keeps a coordinate inside the viewport, without ever going negative. */
function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, MARGIN), Math.max(MARGIN, max - MARGIN));
}
