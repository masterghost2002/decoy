import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * How wide this surface actually is, measured rather than inferred.
 *
 * The layout used to switch on a media query, which reads the *window*. That is
 * the right answer for the popup and the tab view, where the surface is the
 * window, and the wrong one for the floating panel: a 900px panel dragged
 * around a 1600px browser window would ask for the three-pane layout and then
 * have nowhere to put it.
 *
 * Measured in a layout effect, so the corrected width is in place before the
 * first paint and no one sees the drill-down layout flash past on the way to
 * the split one.
 */
export function useSurfaceWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;

    const measure = () => {
      setWidth(node.getBoundingClientRect().width);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return [ref, width];
}
