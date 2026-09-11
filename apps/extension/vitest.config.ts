import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose: the unit tests cover pure helpers
 * and have no need for the react or tailwind plugins.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts?(x)'],
  },
});
