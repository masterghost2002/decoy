/**
 * Bootstraps the floating panel into whatever page it is injected into.
 *
 * Injected on demand by the service worker, never declared in the manifest: a
 * 500kB React bundle has no business loading on every page anyone visits. It
 * runs in the isolated world, which is the one place that has both a DOM and
 * `chrome.runtime`.
 *
 * Running it a second time in the same frame takes the panel away again. The
 * worker cannot ask "is it already there?", so the file is its own toggle.
 */
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { announcePanel } from '@/ui/lib/messaging';
import { setUiRoots } from '@/ui/lib/roots';

import { FloatingPanel } from './FloatingPanel';
import { loadFrame, type PanelFrame } from './frame';

import '@/ui/styles.css';

const INSTALL_FLAG = '__mocksmithPanel';
const HOST_TAG = 'mocksmith-panel';
/** Above any overlay a page is likely to have, and the highest value there is. */
const TOP_LAYER = '2147483647';

interface Installed {
  destroy: () => void;
}

type Scope = Record<string, unknown>;

function claim(): Installed | null {
  const scope = window as unknown as Scope;
  const existing = scope[INSTALL_FLAG] as Installed | undefined;
  if (existing !== undefined) return existing;
  return null;
}

function release(): void {
  delete (window as unknown as Scope)[INSTALL_FLAG];
}

/**
 * A shadow root, because this is somebody else's page. Nothing the site ships
 * can reach in and restyle the panel, and -- just as importantly -- Tailwind's
 * preflight cannot reach out and reset the site's own margins.
 */
function buildHost(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement(HOST_TAG);
  // `all: initial` first, so nothing inherits down from a page that set
  // something inheritable on `html`.
  host.setAttribute(
    'style',
    `all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: ${TOP_LAYER};`,
  );
  // Appended to the documentElement, not the body: a single-page app is
  // entitled to replace its own body, and taking the panel with it would be a
  // mystery disappearance.
  document.documentElement.append(host);
  return { host, shadow: host.attachShadow({ mode: 'open' }) };
}

/**
 * Linked rather than inlined. The stylesheet carries `@font-face` rules whose
 * urls are relative, and relative to a `chrome-extension://` stylesheet they
 * resolve to the extension; inlined into the page they would resolve to the
 * site, and every font would 404.
 */
function linkStyles(shadow: ShadowRoot, onReady: () => void): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('panel.css');
  link.addEventListener('load', onReady, { once: true });
  // A panel that never appears is worse than one that appears unstyled.
  link.addEventListener('error', onReady, { once: true });
  shadow.append(link);
}

function mount(frame: PanelFrame): Installed {
  const { host, shadow } = buildHost();

  // The visible box: rounded, clipped to stay rounded, and positioned by
  // `FloatingPanel` from here on.
  const frameEl = document.createElement('div');
  frameEl.className = 'mocksmith-surface';
  frameEl.setAttribute(
    'style',
    [
      'position: fixed',
      `left: ${String(frame.x)}px`,
      `top: ${String(frame.y)}px`,
      `width: ${String(frame.width)}px`,
      `height: ${String(frame.height)}px`,
      'display: flex',
      'flex-direction: column',
      'border-radius: 14px',
      'overflow: hidden',
      'box-shadow: 0 0 0 1px var(--hairline), 0 24px 64px -12px rgba(0, 0, 0, 0.45)',
      // Until the stylesheet lands this would be an unstyled stack of divs
      // sitting on top of the page.
      'visibility: hidden',
    ].join('; '),
  );

  /**
   * Menus, selects and tooltips portal here. It sits outside the frame on
   * purpose: the frame clips its own corners, and a dropdown portalled inside
   * it would be cut off at the panel's edge.
   */
  const portalEl = document.createElement('div');

  shadow.append(frameEl, portalEl);
  linkStyles(shadow, () => {
    frameEl.style.visibility = 'visible';
  });

  setUiRoots({
    // The host carries `data-theme`, which the stylesheet reads as `:host([...])`.
    themeRoot: host,
    portalContainer: portalEl,
    // Keyboard shortcuts stop at the shadow boundary, so the page keeps its own.
    shortcutRoot: shadow,
  });

  let root: Root | null = createRoot(frameEl);
  announcePanel(true);

  const installed: Installed = {
    destroy: () => {
      announcePanel(false);
      root?.unmount();
      root = null;
      host.remove();
      release();
    },
  };

  root.render(
    <StrictMode>
      <FloatingPanel
        frameEl={frameEl}
        initialFrame={frame}
        onClose={() => {
          installed.destroy();
        }}
      />
    </StrictMode>,
  );

  return installed;
}

function main(): void {
  const existing = claim();
  if (existing !== null) {
    existing.destroy();
    return;
  }

  // Claimed synchronously with a stub, so a second injection arriving while the
  // stored geometry is still being read toggles this one off rather than
  // mounting a second panel on top of it.
  let cancelled = false;
  let real: Installed | null = null;
  const scope = window as unknown as Scope;
  scope[INSTALL_FLAG] = {
    destroy: () => {
      cancelled = true;
      real?.destroy();
      release();
    },
  } satisfies Installed;

  void loadFrame().then((frame) => {
    if (cancelled) return;
    real = mount(frame);
    scope[INSTALL_FLAG] = real;
  });
}

main();
