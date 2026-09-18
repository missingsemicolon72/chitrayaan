import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/fixtures/generate.ts'],
    environment: 'node',
    // Config tests mutate process.env; keep each file isolated.
    isolate: true,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
