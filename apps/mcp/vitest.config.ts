import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Real sockets on real ports: two files binding at once would flake.
    fileParallelism: false,
  },
});
