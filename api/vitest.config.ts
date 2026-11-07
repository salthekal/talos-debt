import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share one database and run in order. It is rebuilt before each file.
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
