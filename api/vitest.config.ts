import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share one database and run in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
