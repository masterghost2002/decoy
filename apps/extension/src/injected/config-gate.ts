import type { DecoyConfig } from '@mocksmith/core';

export interface ConfigGate {
  /** True once config has arrived, or once we gave up waiting for it. */
  readonly isReady: boolean;
  snapshot(): DecoyConfig | null;
  waitUntilReady(): Promise<void>;
  update(config: DecoyConfig): void;
}

/**
 * Both content scripts run at document_start, but their relative order across
 * worlds is not guaranteed, and the config itself has to come from the service
 * worker asynchronously. So the very first requests on a page can be in flight
 * before any rules are known.
 *
 * This gate lets those requests wait briefly rather than escape unmocked, and
 * gives up after `fallbackAfterMs` so a page can never be held hostage by an
 * asleep or reloaded extension.
 */
export function createConfigGate(fallbackAfterMs: number): ConfigGate {
  let config: DecoyConfig | null = null;
  let ready = false;
  let waiters: Array<() => void> = [];

  const open = () => {
    if (ready) return;
    ready = true;
    clearTimeout(fallbackTimer);
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const fallbackTimer = setTimeout(open, fallbackAfterMs);

  return {
    get isReady() {
      return ready;
    },
    snapshot: () => config,
    waitUntilReady: () =>
      ready
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve);
          }),
    update: (next) => {
      config = next;
      open();
    },
  };
}
