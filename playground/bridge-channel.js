/**
 * The one constant the page shares with the extension.
 *
 * Copied rather than imported: `@decoy/core` is TypeScript and this page is
 * served as plain files with no build step, which is itself the point -- the
 * harness has to be something you can open, read and edit while debugging,
 * without a bundler between you and it.
 */
export const PAGE_BRIDGE_CHANNEL = 'decoy.bridge.v1';
