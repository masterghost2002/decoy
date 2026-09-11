import { useEffect, useState } from 'react';

/**
 * Drives the layout switch between the split rules view and the drill-down one.
 * Reads the initial value during state init so the first paint is already
 * correct, rather than flashing the wrong layout.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
}
