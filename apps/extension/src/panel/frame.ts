/**
 * Where the floating panel sits and how big it is, in viewport pixels.
 *
 * Kept separate from the component because it is also the thing that gets
 * persisted, clamped and re-clamped -- a panel that was opened on a 2560px
 * monitor and restored on a laptop has to come back somewhere reachable, not
 * four hundred pixels off the right edge.
 */
export interface PanelFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STORAGE_KEY = 'mocksmith.panel.frame.v1';

/** Below this the two-pane layout has nowhere to go and the form stops working. */
export const MIN_WIDTH = 420;
export const MIN_HEIGHT = 300;

/** Breathing room between the panel and the window edge on a first open. */
const MARGIN = 24;

export function defaultFrame(): PanelFrame {
  const width = Math.max(MIN_WIDTH, Math.min(980, window.innerWidth - MARGIN * 2));
  const height = Math.max(MIN_HEIGHT, Math.min(660, window.innerHeight - MARGIN * 2));
  return {
    // Right-hand side by default: most apps put their own content on the left,
    // and this is a tool you watch a page through rather than instead of.
    x: Math.max(MARGIN, window.innerWidth - width - MARGIN),
    y: MARGIN,
    width,
    height,
  };
}

/**
 * Keeps the whole panel on screen. Fully on screen rather than "mostly", because
 * the only way back from a panel dragged off the edge is to close it, and the
 * button that does that is on the part that went missing.
 */
export function clampFrame(frame: PanelFrame): PanelFrame {
  const width = Math.max(MIN_WIDTH, Math.min(frame.width, window.innerWidth));
  const height = Math.max(MIN_HEIGHT, Math.min(frame.height, window.innerHeight));
  return {
    width,
    height,
    x: Math.min(Math.max(0, frame.x), Math.max(0, window.innerWidth - width)),
    y: Math.min(Math.max(0, frame.y), Math.max(0, window.innerHeight - height)),
  };
}

function isFrame(value: unknown): value is PanelFrame {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]),
  );
}

export async function loadFrame(): Promise<PanelFrame> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw: unknown = stored[STORAGE_KEY];
    return clampFrame(isFrame(raw) ? raw : defaultFrame());
  } catch {
    return defaultFrame();
  }
}

export function saveFrame(frame: PanelFrame): void {
  void chrome.storage.local.set({ [STORAGE_KEY]: frame }).catch(() => undefined);
}
