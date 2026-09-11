/**
 * Reached through globalThis so this module needs neither the DOM nor the Node
 * type libs; it runs in a page, a service worker and a test runner alike.
 */
const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

/** Short, collision-resistant ids. Prefixed so a stray id is traceable to its kind. */
export function createId(prefix: string): string {
  const uuid =
    typeof webCrypto?.randomUUID === 'function'
      ? webCrypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid.replace(/-/g, '').slice(0, 12)}`;
}
