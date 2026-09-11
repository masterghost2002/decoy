import { useEffect, useState } from 'react';

/**
 * A clock that only runs when something on screen is actually decaying.
 *
 * The `fired 2s ago` stamps have to age, but a permanent one-second timer would
 * re-render the whole rule list forever for the sake of text that stops
 * changing after a minute. So the caller says when it cares.
 */
export function useTicker(active: boolean, intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Sampled immediately as well, so re-activating does not show a stale clock.
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  return now;
}
