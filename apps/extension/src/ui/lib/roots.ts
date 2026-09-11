/**
 * The three places this UI reaches outside its own component tree.
 *
 * In the popup and the full tab all three are the document, and none of this
 * matters. In the floating panel none of them are: the UI lives in a shadow
 * root inside someone else's page, and each of these left alone would reach out
 * and touch that page instead.
 *
 *  - the **theme root** carries `data-theme`. On the document that is the html
 *    element; in the panel it is the shadow host, or flipping to dark would
 *    restyle the site underneath.
 *  - the **portal container** is where Radix hangs menus, dialogs and tooltips.
 *    Radix defaults to `document.body`, which is outside the shadow root and so
 *    outside every stylesheet the panel has -- an unstyled menu in the page.
 *  - the **shortcut root** is what keyboard shortcuts listen on. Bound to
 *    `window` inside a page, Decoy would eat the host app's ⌘K and ⌘S.
 *
 * Module state rather than context because these are set once, during bootstrap,
 * before the first render -- and a context would have to be threaded through
 * every leaf that portals, which is most of them.
 */

let themeRoot: HTMLElement | null = null;
let portalContainer: HTMLElement | null = null;
let shortcutRoot: EventTarget | null = null;

export interface UiRoots {
  themeRoot: HTMLElement;
  portalContainer: HTMLElement;
  shortcutRoot: EventTarget;
}

export function setUiRoots(roots: UiRoots): void {
  themeRoot = roots.themeRoot;
  portalContainer = roots.portalContainer;
  shortcutRoot = roots.shortcutRoot;
}

export function getThemeRoot(): HTMLElement {
  return themeRoot ?? document.documentElement;
}

/** `undefined` hands the decision back to Radix, whose default is `document.body`. */
export function getPortalContainer(): HTMLElement | undefined {
  return portalContainer ?? undefined;
}

export function getShortcutRoot(): EventTarget {
  return shortcutRoot ?? window;
}

/**
 * The element a keyboard or pointer event actually started on.
 *
 * `event.target` is retargeted at a shadow boundary: to a listener outside the
 * tree, every event from inside the panel appears to come from the host element
 * itself. That turns "is the cursor in a text field?" into a question that is
 * always answered no.
 */
export function originalTarget(event: Event): HTMLElement | null {
  const path = event.composedPath();
  const first = path.length > 0 ? path[0] : event.target;
  return first instanceof HTMLElement ? first : null;
}
