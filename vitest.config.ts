import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/pg/**'],
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
    ],
  },
});
