import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/pg/**', 'test/bench/**', 'test/live/**'],
        },
      },
      {
        test: {
          name: 'pg',
          include: ['test/pg/**/*.pg.test.ts'],
          globalSetup: ['test/pg/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // Measurement only (npm run bench); not part of npm run check.
        test: {
          name: 'bench',
          include: ['test/bench/**/*.bench.test.ts'],
        },
      },
      {
        // Real network calls (npm run test:live); skipped with a reason unless explicitly enabled.
        test: {
          name: 'live',
          include: ['test/live/**/*.live.test.ts'],
        },
      },
    ],
  },
});
