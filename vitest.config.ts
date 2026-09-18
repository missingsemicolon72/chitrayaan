import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Config tests mutate process.env; keep each file isolated.
    isolate: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
